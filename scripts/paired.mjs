// Shared machinery for same-runner paired benchmarks.
//
// Every workflow here measures each arm twice inside a single job, in an order
// that is mirrored about the middle of the job. For two arms that is ABBA; for N
// arms it is 1..N followed by N..1. Two properties follow:
//
//   - Differencing within a runner removes between-runner variance, which on
//     hosted runners is larger than the effects under test and cannot be
//     averaged away by adding independent jobs to each arm.
//   - Averaging an arm's two slots removes any drift that is linear across the
//     job, because the mirrored order places those slots symmetrically about the
//     centre.
//
// Measuring each arm twice also yields a null-effect (A/A) estimate at no extra
// job cost: the spread between an arm's own two slots is what the harness
// reports when nothing has changed.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  classify,
  hodgesLehmann,
  mean,
  median,
  medianAbsoluteDeviation,
  pairedInterval,
  pairedPermutationTest,
  quantile,
  standardDeviation,
} from "./stats.mjs";

export const RESULTS_DIR = ".benchmark-results";

// Each measurement job uploads its own CSV so that merging the artifacts cannot
// overwrite another runner's samples.
export async function readSampleFiles(prefix, directory = RESULTS_DIR) {
  const entries = await readdir(directory);
  const files = entries.filter(
    (entry) => entry.startsWith(prefix) && entry.endsWith(".csv"),
  );
  if (files.length === 0) {
    throw new Error(`No ${prefix}*.csv timing files found in ${directory}`);
  }
  const contents = await Promise.all(
    files.sort().map((file) => readFile(join(directory, file), "utf8")),
  );
  return contents.join("\n");
}

export function parseSamples(csv) {
  return csv
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sample, arm, slot, elapsedMs] = line
        .split(",")
        .map((value) => value.replace(/^"|"$/g, ""));
      return {
        sample: Number(sample),
        arm,
        slot: Number(slot),
        seconds: Number(elapsedMs) / 1000,
      };
    });
}

// Groups rows by runner and arm, keeping only runners that measured every arm
// the expected number of times. A runner that failed part way through would
// otherwise contribute a difference computed from unbalanced slots.
export function groupByRunner(rows, arms, slotsPerArm = 2) {
  const bySample = new Map();
  for (const row of rows) {
    if (!arms.includes(row.arm)) continue;
    const entry = bySample.get(row.sample) ?? new Map();
    entry.set(row.arm, [...(entry.get(row.arm) ?? []), row]);
    bySample.set(row.sample, entry);
  }
  const runners = [];
  for (const [sample, entry] of [...bySample.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    if (arms.some((arm) => (entry.get(arm) ?? []).length !== slotsPerArm)) {
      continue;
    }
    const slots = new Map();
    for (const arm of arms) {
      slots.set(
        arm,
        entry
          .get(arm)
          .sort((a, b) => a.slot - b.slot)
          .map((row) => row.seconds),
      );
    }
    runners.push({ sample, slots });
  }
  return runners;
}

export function buildPairs(
  rows,
  baselineArm = "baseline",
  candidateArm = "candidate",
) {
  return groupByRunner(rows, [baselineArm, candidateArm]).map((runner) => {
    const baselineSlots = runner.slots.get(baselineArm);
    const candidateSlots = runner.slots.get(candidateArm);
    return {
      sample: runner.sample,
      baselineSlots,
      candidateSlots,
      baseline: mean(baselineSlots),
      candidate: mean(candidateSlots),
      difference: mean(candidateSlots) - mean(baselineSlots),
      baselineRepeatDelta: baselineSlots[1] - baselineSlots[0],
      candidateRepeatDelta: candidateSlots[1] - candidateSlots[0],
    };
  });
}

// A slot can stall on the cache service for several seconds. Such a runner is
// not measuring the effect, and which arm the stall lands on is arbitrary, so it
// contributes an arbitrarily large difference.
//
// The filter looks only at how much an arm disagrees with itself, which is a
// pure noise quantity: it has the same distribution whether or not the arms
// differ. Excluding runners on it therefore cannot bias the estimated effect,
// unlike filtering on the difference between arms. The threshold is robust
// (median plus a multiple of the median absolute deviation) so that it adapts to
// the run rather than being a fixed number of seconds.
export function dropStalledRunners(pairs, { tolerance = 6, spreadOf } = {}) {
  if (pairs.length < 4) return { kept: pairs, dropped: [] };
  const spreads = pairs.map(
    spreadOf ??
      ((pair) =>
        Math.max(
          Math.abs(pair.baselineRepeatDelta),
          Math.abs(pair.candidateRepeatDelta),
        )),
  );
  const limit =
    median(spreads) +
    tolerance * Math.max(medianAbsoluteDeviation(spreads), 1e-9);
  const kept = [];
  const dropped = [];
  pairs.forEach((pair, index) => {
    if (spreads[index] > limit) {
      dropped.push({ sample: pair.sample, repeatSpread: spreads[index] });
    } else {
      kept.push(pair);
    }
  });
  // Never discard so much that what remains cannot support a verdict.
  if (kept.length < Math.ceil(pairs.length / 2)) {
    return { kept: pairs, dropped: [] };
  }
  return { kept, dropped, thresholdSeconds: limit };
}

// The smallest effect the harness can trust, derived from how much the same
// implementation varies between its two slots on one runner.
export function noiseFloor(pairs) {
  const repeats = [
    ...pairs.map((pair) => Math.abs(pair.baselineRepeatDelta)),
    ...pairs.map((pair) => Math.abs(pair.candidateRepeatDelta)),
  ];
  if (repeats.length === 0) return 0;
  return quantile(repeats, 0.5);
}

export function armSummary(name, values) {
  return {
    arm: name,
    samples: values.length,
    meanSeconds: mean(values),
    medianSeconds: median(values),
    standardDeviationSeconds: standardDeviation(values),
    madSeconds: medianAbsoluteDeviation(values),
    p95Seconds: quantile(values, 0.95),
  };
}

export function analyzePairs(
  rows,
  baselineArm = "baseline",
  candidateArm = "candidate",
) {
  const allPairs = buildPairs(rows, baselineArm, candidateArm);
  const {
    kept: pairs,
    dropped,
    thresholdSeconds,
  } = dropStalledRunners(allPairs);
  const differences = pairs.map((pair) => pair.difference);
  const baselineValues = pairs.map((pair) => pair.baseline);
  const candidateValues = pairs.map((pair) => pair.candidate);
  const floor = noiseFloor(pairs);
  const interval = pairedInterval(differences, { seed: 1 });
  const pValue = pairedPermutationTest(differences, { seed: 3 });
  // The same estimator applied to the within-arm repeats. A trustworthy harness
  // must not resolve a difference here, because it compares an arm with itself.
  // Judged against the same noise floor as the real effect, so a healthy run
  // reports `within-noise` or `inconclusive`.
  const controlDifferences = pairs.map((pair) => pair.baselineRepeatDelta);
  const controlInterval = pairedInterval(controlDifferences, { seed: 2 });
  const controlPValue = pairedPermutationTest(controlDifferences, { seed: 4 });
  return {
    pairs,
    noiseFloorSeconds: floor,
    baseline: armSummary(baselineArm, baselineValues),
    candidate: armSummary(candidateArm, candidateValues),
    interval,
    pValue,
    shiftSeconds: hodgesLehmann(candidateValues, baselineValues),
    verdict: classify(interval, { noiseFloor: floor, pValue }),
    droppedRunners: dropped,
    stallThresholdSeconds: thresholdSeconds,
    control: {
      interval: controlInterval,
      pValue: controlPValue,
      verdict: classify(controlInterval, {
        noiseFloor: floor,
        pValue: controlPValue,
      }),
    },
  };
}

// Compares a reference arm against every other arm, one paired difference per
// runner. Used where the workflow measures more than two implementations in the
// same job, such as the version sweep.
//
// The difference is reference minus arm, so the reference plays the same role
// the candidate plays in the two-arm workflows: it is the code under test and
// each other arm is a baseline it is measured against. In the version sweep the
// reference is `main`, which is the newest code, so this is the direction that
// makes the verdicts mean what they say. Differencing the other way would call
// a released version a `regression` for being slower than the code that
// succeeded it, when what has been measured is `main` being faster.
export function analyzeAgainstReference(rows, arms, reference) {
  const allRunners = groupByRunner(rows, arms);
  // Same filter as the two-arm workflows, applied across every arm: a runner
  // whose slots for one version disagree with each other has stalled, and the
  // arm the stall landed on is arbitrary.
  const {
    kept: runners,
    dropped,
    thresholdSeconds,
  } = dropStalledRunners(allRunners, {
    spreadOf: (runner) =>
      Math.max(
        ...arms.map((arm) => {
          const slots = runner.slots.get(arm);
          return Math.abs(slots[1] - slots[0]);
        }),
      ),
  });
  const perArm = new Map(
    arms.map((arm) => [
      arm,
      runners.map((runner) => mean(runner.slots.get(arm))),
    ]),
  );
  const repeats = runners.flatMap((runner) =>
    arms.map((arm) => {
      const slots = runner.slots.get(arm);
      return Math.abs(slots[1] - slots[0]);
    }),
  );
  const floor = repeats.length === 0 ? 0 : quantile(repeats, 0.5);
  const referenceValues = perArm.get(reference) ?? [];
  const comparisons = arms.map((arm, index) => {
    const values = perArm.get(arm);
    const differences = values.map(
      (value, runner) => referenceValues[runner] - value,
    );
    const isReference = arm === reference;
    const interval = isReference
      ? null
      : pairedInterval(differences, { seed: 10 + index });
    return {
      arm,
      isReference,
      summary: armSummary(arm, values),
      differenceSeconds: isReference ? 0 : mean(differences),
      interval,
      pValue: isReference
        ? null
        : pairedPermutationTest(differences, { seed: 50 + index }),
      verdict: isReference
        ? "reference"
        : classify(interval, {
            noiseFloor: floor,
            pValue: pairedPermutationTest(differences, { seed: 50 + index }),
          }),
    };
  });
  // Each arm's own two slots compared with themselves. Nothing changed between
  // them, so anything the estimator resolves here is harness bias.
  const controlDifferences = runners.map((runner) => {
    const slots = runner.slots.get(reference);
    return slots[1] - slots[0];
  });
  const controlInterval =
    controlDifferences.length === 0
      ? null
      : pairedInterval(controlDifferences, { seed: 99 });
  const controlPValue =
    controlDifferences.length === 0
      ? null
      : pairedPermutationTest(controlDifferences, { seed: 98 });
  return {
    runners,
    arms,
    reference,
    noiseFloorSeconds: floor,
    droppedRunners: dropped,
    stallThresholdSeconds: thresholdSeconds,
    comparisons,
    control: {
      interval: controlInterval,
      pValue: controlPValue,
      verdict: classify(controlInterval, {
        noiseFloor: floor,
        pValue: controlPValue,
      }),
    },
  };
}

// Every name passed here ends up in the published report, so a missing value has
// to fail with the name of what is missing. Rendering `undefined` into a results
// table is worse than not rendering one at all.
export function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
}
