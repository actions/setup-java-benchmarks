// What does setup-java's own code cost?
//
// This report answers two different questions from one matrix, and they need
// different treatment.
//
// The first is the comparison: does the candidate differ from the baseline?
// Each configuration is one runner, so it yields one paired difference and
// cannot support an interval alone. Configurations are treated as blocks — arms
// compared within a configuration, on the same runner, in ABBA order — and the
// differences pooled.
//
// The second is the decomposition, and it is not a comparison at all. The four
// cache profiles are nested levels of work: `none` never touches the cache code,
// `maven-miss` computes a key and is told no, `maven-hit` also unpacks a small
// entry. Differencing the levels says where the time goes, which is the number a
// maintainer deciding whether an optimization is worth it actually needs. Those
// differences are between-configuration, so they are reported as observed
// medians without intervals; they are descriptive, and labelled as such.

import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { analyzePairs, requireEnv } from "./paired.mjs";
import { describeVerdict, formatInterval, holmAdjust } from "./stats.mjs";

const RESULTS_DIR = ".benchmark-results";
const OUTPUT_DIR = "action-overhead-results";

const CACHE_PROFILES = [
  {
    id: "none",
    label: "No cache",
    describes: "the action never touches the cache code",
  },
  {
    id: "maven-miss",
    label: "Maven, miss",
    describes: "a key is computed and the service says no",
  },
  {
    id: "maven-hit",
    label: "Maven, hit",
    describes: "a key is computed and a ~1 MiB entry is unpacked",
  },
  {
    id: "gradle-miss",
    label: "Gradle, miss",
    describes: "the same as a Maven miss through the other package manager",
  },
];

const STEPS = [
  {
    from: "none",
    to: "maven-miss",
    label: "Computing a key and asking the cache service",
  },
  {
    from: "maven-miss",
    to: "maven-hit",
    label: "Restoring and unpacking a ~1 MiB entry",
  },
];

function unquote(value) {
  const trimmed = (value ?? "").trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replaceAll('""', '"')
    : trimmed;
}

// os,cache,layout,arm,slot,cacheHit,elapsedMs
export function parseSamples(csv) {
  return csv
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [os, cache, layout, arm, slot, cacheHit, elapsedMs] = line
        .split(",")
        .map(unquote);
      return {
        configuration: `${os}/${cache}/${layout}`,
        os,
        cache,
        layout,
        arm,
        slot: Number(slot),
        cacheHit,
        seconds: Number(elapsedMs) / 1000,
      };
    })
    .filter((row) => Number.isFinite(row.seconds));
}

// paired.mjs groups by a numeric `sample`, so each configuration is assigned a
// stable index and becomes one block.
export function toPairedRows(rows) {
  const configurations = [
    ...new Set(rows.map((row) => row.configuration)),
  ].sort();
  const index = new Map(configurations.map((name, at) => [name, at + 1]));
  return {
    configurations,
    rows: rows.map((row) => ({
      sample: index.get(row.configuration),
      arm: row.arm,
      slot: row.slot,
      seconds: row.seconds,
    })),
  };
}

export async function readResults(directory = RESULTS_DIR) {
  const entries = await readdir(directory, { recursive: true });
  const files = entries.filter(
    (entry) => entry.endsWith(".csv") && entry.includes("action-overhead"),
  );
  if (files.length === 0) {
    throw new Error(`No action-overhead CSV files found in ${directory}`);
  }
  const contents = await Promise.all(
    files.sort().map((file) => readFile(join(directory, file), "utf8")),
  );
  return contents.join("\n");
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function subsetAnalysis(rows, predicate) {
  const subset = rows.filter(predicate);
  if (subset.length === 0) return null;
  const { rows: paired } = toPairedRows(subset);
  const analysis = analyzePairs(paired, "baseline", "candidate");
  return analysis.pairs.length === 0 ? null : analysis;
}

// A `maven-hit` slot that reported a miss did not measure a restore, and a
// `maven-miss` slot that reported a hit found an entry that should not exist.
// Either turns a level of the decomposition into a different level, so the
// numbers below it stop meaning what they are labelled, and that has to be said
// loudly rather than buried.
export function checkCacheIntegrity(rows) {
  const expectations = { "maven-hit": "true", "maven-miss": "false" };
  const problems = [];
  for (const row of rows) {
    const expected = expectations[row.cache];
    if (!expected) continue;
    if (row.cacheHit === "unset" || row.cacheHit === "") {
      problems.push({
        configuration: row.configuration,
        slot: row.slot,
        reported: "nothing",
        expected,
        reason:
          "the ref does not publish `cache-hit`, so this slot cannot be verified",
      });
    } else if (row.cacheHit !== expected) {
      problems.push({
        configuration: row.configuration,
        slot: row.slot,
        reported: row.cacheHit,
        expected,
        reason: "the slot did not do the work its profile is named for",
      });
    }
  }
  return problems;
}

export function decompose(rows) {
  const byOs = [...new Set(rows.map((row) => row.os))].sort();
  const levels = byOs.map((os) => {
    const seconds = {};
    for (const profile of CACHE_PROFILES) {
      seconds[profile.id] = median(
        rows
          .filter((row) => row.os === os && row.cache === profile.id)
          .map((row) => row.seconds),
      );
    }
    return { os, seconds };
  });
  const steps = byOs.map((os) => {
    const level = levels.find((entry) => entry.os === os);
    return {
      os,
      steps: STEPS.map(({ from, to, label }) => ({
        label,
        seconds:
          level.seconds[from] === null || level.seconds[to] === null
            ? null
            : level.seconds[to] - level.seconds[from],
      })),
    };
  });
  return { levels, steps };
}

function seconds(value, digits = 3) {
  return value === null || value === undefined
    ? "n/a"
    : `${value >= 0 ? "" : "−"}${Math.abs(value).toFixed(digits)}s`;
}

function analysisRow(label, analysis, adjustedP) {
  if (!analysis) return `| ${label} | no usable pairs | | | |`;
  return [
    `| ${label}`,
    seconds(analysis.interval.estimate),
    formatInterval(analysis.interval),
    adjustedP === null || adjustedP === undefined
      ? analysis.pValue.toFixed(3)
      : adjustedP.toFixed(3),
    analysis.verdict,
  ]
    .join(" | ")
    .concat(" |");
}

export function markdown(
  metadata,
  overall,
  byProfile,
  byOs,
  decomposition,
  problems,
  sizes,
) {
  const lines = [
    "# Action overhead",
    "",
    `Baseline \`${metadata.baselineRef}\` vs candidate \`${metadata.candidateRef}\` from \`${metadata.setupJavaRepository}\`, run ${metadata.runId}.`,
    "",
    "The cache entry here is about a megabyte, deliberately. setup-java hands the",
    "actual transfer to `@actions/cache`, so a large entry would time the network",
    "and hide the action's own work. A small one leaves resolving a distribution,",
    "computing a cache key, writing settings and toolchains, and the bookkeeping",
    "around a restore as what is measured.",
    "",
  ];

  if (problems.length > 0) {
    lines.push(
      "## The cache did not behave as the profiles assume",
      "",
      "Every number below this point is suspect, because at least one slot did not",
      "do the work its profile is named for.",
      "",
      "| Configuration | Slot | Expected `cache-hit` | Reported | Why it matters |",
      "| --- | ---: | --- | --- | --- |",
      ...problems
        .slice(0, 20)
        .map(
          (problem) =>
            `| ${problem.configuration} | ${problem.slot} | ${problem.expected} | ${problem.reported} | ${problem.reason} |`,
        ),
      "",
    );
  }

  lines.push(
    "## Does the candidate differ from the baseline?",
    "",
    `**${overall ? describeVerdict(overall.verdict) : "No usable pairs."}**`,
    "",
  );

  if (overall) {
    lines.push(
      `Pooled across ${overall.pairs.length} configurations: ${formatInterval(overall.interval)}, permutation p = ${overall.pValue.toFixed(3)}, noise floor ${seconds(overall.noiseFloorSeconds)}.`,
      "",
      `The A/A control — the two baseline slots against each other, which differ by nothing — reads ${overall.control.verdict}. Anything other than \`within-noise\` or \`inconclusive\` there means the harness is measuring something it should not, and the comparison above cannot be trusted.`,
      "",
      "| Split | Difference | Interval | p (Holm) | Verdict |",
      "| --- | ---: | --- | ---: | --- |",
      ...byProfile.map(({ label, analysis, adjustedP }) =>
        analysisRow(label, analysis, adjustedP),
      ),
      ...byOs.map(({ label, analysis }) => analysisRow(label, analysis, null)),
      "",
    );
  }

  lines.push(
    "## Where the time goes",
    "",
    "Observed medians, not a comparison. These are levels measured on different",
    "runners, so they carry no interval and no verdict; they are here to say what",
    "a setup actually costs and which part of it setup-java could change.",
    "",
    `| OS | ${CACHE_PROFILES.map((profile) => profile.label).join(" | ")} |`,
    `| --- | ${CACHE_PROFILES.map(() => "---:").join(" | ")} |`,
    ...decomposition.levels.map(
      (level) =>
        `| ${level.os} | ${CACHE_PROFILES.map((profile) => seconds(level.seconds[profile.id], 2)).join(" | ")} |`,
    ),
    "",
    `| OS | ${STEPS.map((step) => step.label).join(" | ")} |`,
    `| --- | ${STEPS.map(() => "---:").join(" | ")} |`,
    ...decomposition.steps.map(
      (entry) =>
        `| ${entry.os} | ${entry.steps.map((step) => seconds(step.seconds, 2)).join(" | ")} |`,
    ),
    "",
  );

  if (sizes.length > 0) {
    lines.push(
      "## Bundle size",
      "",
      "How much JavaScript each arm has to parse before it does anything.",
      "",
      "| Arm | `dist/setup/index.js` bytes | `dist/setup` JS bytes | JS files |",
      "| --- | ---: | ---: | ---: |",
      ...sizes.map(
        (size) =>
          `| ${size.arm} | ${size.indexBytes} | ${size.jsBytes} | ${size.files} |`,
      ),
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

async function readSizes(directory = RESULTS_DIR) {
  let entries;
  try {
    entries = await readdir(directory, { recursive: true });
  } catch {
    return [];
  }
  const files = entries.filter((entry) => entry.endsWith("sizes.csv"));
  const contents = await Promise.all(
    files.sort().map((file) => readFile(join(directory, file), "utf8")),
  );
  const seen = new Map();
  for (const line of contents.join("\n").trim().split("\n")) {
    if (!line.trim()) continue;
    const [arm, indexBytes, jsBytes, files_] = line.split(",");
    if (!seen.has(arm)) {
      seen.set(arm, { arm, indexBytes, jsBytes, files: files_ });
    }
  }
  return [...seen.values()];
}

export async function main(env = process.env) {
  requireEnv(env, [
    "SETUP_JAVA_REPOSITORY",
    "BASELINE_REF",
    "CANDIDATE_REF",
    "RUN_ID",
  ]);

  const rows = parseSamples(await readResults());
  const { rows: paired } = toPairedRows(rows);
  const overall =
    paired.length > 0 ? analyzePairs(paired, "baseline", "candidate") : null;

  const profileAnalyses = CACHE_PROFILES.map((profile) => ({
    label: profile.label,
    analysis: subsetAnalysis(rows, (row) => row.cache === profile.id),
  }));
  // Four cache profiles are four chances to find a difference that is not there,
  // so the family is corrected together.
  const adjusted = holmAdjust(
    profileAnalyses.map(({ analysis }) => (analysis ? analysis.pValue : null)),
  );
  const byProfile = profileAnalyses.map((entry, index) => ({
    ...entry,
    adjustedP: adjusted[index],
  }));

  const byOs = [...new Set(rows.map((row) => row.os))].sort().map((os) => ({
    label: os,
    analysis: subsetAnalysis(rows, (row) => row.os === os),
  }));

  const problems = checkCacheIntegrity(rows);
  const decomposition = decompose(rows);
  const sizes = await readSizes();

  const metadata = {
    setupJavaRepository: env.SETUP_JAVA_REPOSITORY,
    baselineRef: env.BASELINE_REF,
    candidateRef: env.CANDIDATE_REF,
    runId: env.RUN_ID,
  };

  const rendered = markdown(
    metadata,
    overall,
    byProfile,
    byOs,
    decomposition,
    problems,
    sizes,
  );

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(
    join(OUTPUT_DIR, "results.json"),
    `${JSON.stringify({ metadata, overall, byProfile, byOs, decomposition, problems, sizes }, null, 2)}\n`,
  );
  await writeFile(join(OUTPUT_DIR, "summary.md"), rendered);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, rendered);
  }
  return rendered;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
