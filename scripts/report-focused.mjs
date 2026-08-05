import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { hashFilesSingle } from "./report.mjs";
import {
  classify,
  describeVerdict,
  formatInterval,
  hodgesLehmann,
  mean,
  median,
  medianAbsoluteDeviation,
  pairedInterval,
  pairedPermutationTest,
  quantile,
  standardDeviation,
} from "./stats.mjs";

const API_VERSION = "2022-11-28";
const RESULTS_DIR = ".benchmark-results";

// Every measurement job uploads its own CSV so that merging the artifacts
// cannot overwrite another runner's samples.
export async function readSampleFiles(directory = RESULTS_DIR) {
  const entries = await readdir(directory);
  const files = entries.filter(
    (entry) => entry.startsWith("focused-timings") && entry.endsWith(".csv"),
  );
  if (files.length === 0) {
    throw new Error(`No focused timing CSVs found in ${directory}`);
  }
  const contents = await Promise.all(
    files.sort().map((file) => readFile(join(directory, file), "utf8")),
  );
  return contents.join("\n");
}

// Each runner measures four slots in ABBA order: baseline, candidate,
// candidate, baseline. Averaging the two slots per arm cancels any linear drift
// across the job, and differencing within a runner removes between-runner
// variance.
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

// One paired observation per runner, plus the within-arm repeat difference that
// serves as a null-effect (A/A) measurement requiring no extra jobs.
export function buildPairs(rows) {
  const bySample = new Map();
  for (const row of rows) {
    const entry = bySample.get(row.sample) ?? { baseline: [], candidate: [] };
    if (!entry[row.arm]) continue;
    entry[row.arm].push(row);
    bySample.set(row.sample, entry);
  }
  const pairs = [];
  for (const [sample, entry] of [...bySample.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    if (entry.baseline.length !== 2 || entry.candidate.length !== 2) continue;
    const baselineSlots = entry.baseline
      .sort((a, b) => a.slot - b.slot)
      .map((row) => row.seconds);
    const candidateSlots = entry.candidate
      .sort((a, b) => a.slot - b.slot)
      .map((row) => row.seconds);
    pairs.push({
      sample,
      baselineSlots,
      candidateSlots,
      baseline: mean(baselineSlots),
      candidate: mean(candidateSlots),
      difference: mean(candidateSlots) - mean(baselineSlots),
      baselineRepeatDelta: baselineSlots[1] - baselineSlots[0],
      candidateRepeatDelta: candidateSlots[1] - candidateSlots[0],
    });
  }
  return pairs;
}

// The smallest effect the harness can trust. Derived from how much the same
// implementation varies between its two slots on one runner.
export function noiseFloor(pairs) {
  const repeats = [
    ...pairs.map((pair) => Math.abs(pair.baselineRepeatDelta)),
    ...pairs.map((pair) => Math.abs(pair.candidateRepeatDelta)),
  ];
  if (repeats.length === 0) return 0;
  return quantile(repeats, 0.5);
}

function armSummary(name, values) {
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

export function analyze(rows) {
  const pairs = buildPairs(rows);
  const differences = pairs.map((pair) => pair.difference);
  const baselineValues = pairs.map((pair) => pair.baseline);
  const candidateValues = pairs.map((pair) => pair.candidate);
  const floor = noiseFloor(pairs);
  const interval = pairedInterval(differences, { seed: 1 });
  // The same estimator applied to the within-arm repeats. A trustworthy harness
  // must not resolve a difference here, because it compares an arm with itself.
  // Judged against the same noise floor as the real effect, so a healthy run
  // reports `within-noise` or `inconclusive`.
  const controlInterval = pairedInterval(
    pairs.map((pair) => pair.baselineRepeatDelta),
    { seed: 2 },
  );
  return {
    pairs,
    noiseFloorSeconds: floor,
    baseline: armSummary("baseline", baselineValues),
    candidate: armSummary("candidate", candidateValues),
    interval,
    pValue: pairedPermutationTest(differences, { seed: 3 }),
    shiftSeconds: hodgesLehmann(candidateValues, baselineValues),
    verdict: classify(interval, { noiseFloor: floor }),
    control: {
      interval: controlInterval,
      verdict: classify(controlInterval, { noiseFloor: floor }),
    },
  };
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function api(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path}: ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function allPages(path, field, token) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await api(
      `${path}${separator}per_page=100&page=${page}`,
      token,
    );
    values.push(...response[field]);
    if (response[field].length < 100) return values;
  }
}

export function markdown(metadata, analysis, caches) {
  const { baseline, candidate, interval, control } = analysis;
  const lines = [
    "# Focused cache restore benchmark",
    "",
    `Temurin ${metadata.javaVersion}, ${analysis.pairs.length} runners x 2 paired observations, run ${metadata.runId}.`,
    `Baseline \`${metadata.baselineRef}\` vs candidate \`${metadata.candidateRef}\` from \`${metadata.setupJavaRepository}\`.`,
    "",
    "## Verdict",
    "",
    `**${describeVerdict(analysis.verdict)}**`,
    "",
    `Paired difference (candidate - baseline): **${formatInterval(interval, { digits: 3 })}**.`,
    `Permutation p-value: ${analysis.pValue.toFixed(3)}. Hodges-Lehmann shift: ${analysis.shiftSeconds.toFixed(3)}s.`,
    `Harness noise floor: ${analysis.noiseFloorSeconds.toFixed(3)}s (median within-runner repeat spread).`,
    "",
    `A/A control (baseline against itself) reports **${control.verdict}** at ${formatInterval(control.interval, { digits: 3 })}. A healthy harness reports \`within-noise\` or \`inconclusive\` here; an \`improvement\` or \`regression\` means slot ordering is biasing results and the verdict above cannot be trusted.`,
    "",
    "## Arms",
    "",
    "| Arm | Runners | Mean (s) | Median (s) | SD (s) | MAD (s) | p95 (s) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const summary of [baseline, candidate]) {
    lines.push(
      `| ${summary.arm} | ${summary.samples} | ${summary.meanSeconds.toFixed(3)} | ${summary.medianSeconds.toFixed(3)} | ${summary.standardDeviationSeconds?.toFixed(3) ?? "n/a"} | ${summary.madSeconds.toFixed(3)} | ${summary.p95Seconds.toFixed(3)} |`,
    );
  }
  lines.push(
    "",
    "All durations are measured inside the job with millisecond resolution. The Actions API reports step timestamps only to the nearest second, which is too coarse for effects of this size.",
    "",
    "## Paired samples",
    "",
    "| Runner | baseline slot 1 (s) | candidate slot 2 (s) | candidate slot 3 (s) | baseline slot 4 (s) | Paired delta (s) |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const pair of analysis.pairs) {
    lines.push(
      `| ${pair.sample} | ${pair.baselineSlots[0].toFixed(3)} | ${pair.candidateSlots[0].toFixed(3)} | ${pair.candidateSlots[1].toFixed(3)} | ${pair.baselineSlots[1].toFixed(3)} | ${pair.difference.toFixed(3)} |`,
    );
  }
  lines.push(
    "",
    "## Cache fixtures",
    "",
    "Both arms restore the same entries, so the stored blob cannot bias the comparison.",
    "",
    "| Cache | Size (MiB) |",
    "| --- | ---: |",
  );
  for (const cache of caches) {
    lines.push(
      `| ${cache.type} | ${(cache.sizeBytes / 1024 / 1024).toFixed(1)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function main(env = process.env) {
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  const token = env.GH_TOKEN;
  const runId = env.GITHUB_RUN_ID;
  const baselineRef = env.BASELINE_REF;
  const candidateRef = env.CANDIDATE_REF;
  const setupJavaRepository = env.SETUP_JAVA_REPOSITORY;
  if (!owner || !repo || !token || !runId || !baselineRef || !candidateRef) {
    throw new Error("Missing required GitHub Actions environment variables");
  }

  const rows = parseSamples(await readSampleFiles());
  const analysis = analyze(rows);
  if (analysis.pairs.length === 0) {
    throw new Error("No complete ABBA samples were collected");
  }

  const cacheEntries = await allPages(
    `/repos/${owner}/${repo}/actions/caches`,
    "actions_caches",
    token,
  );

  // Both arms restore this single entry, so the stored blob cannot bias the
  // comparison. The wrapper entry is optional: a baseline that predates wrapper
  // caching simply never restores it.
  const benchmarkId = `focused-${runId}`;
  const expected = [
    {
      type: "maven-dependencies",
      key: `setup-java-Linux-x64-maven-${hashFilesSingle(`${benchmarkId}\n`)}`,
      required: true,
    },
    {
      type: "maven-wrapper",
      key: `setup-java-Linux-x64-maven-wrapper-${hashFilesSingle(
        `wrapperVersion=focused\n# benchmark-id=${benchmarkId}\n`,
      )}`,
      required: false,
    },
  ];

  const caches = [];
  for (const item of expected) {
    const entry = cacheEntries.find((cache) => cache.key === item.key);
    if (!entry) {
      if (item.required) {
        throw new Error(`Expected cache not found: ${item.key}`);
      }
      continue;
    }
    caches.push({
      type: item.type,
      id: entry.id,
      key: item.key,
      sizeBytes: entry.size_in_bytes,
    });
  }

  const metadata = {
    repository: env.GITHUB_REPOSITORY,
    runId,
    javaVersion: env.JAVA_VERSION,
    setupJavaRepository,
    baselineRef,
    candidateRef,
    generatedAt: new Date().toISOString(),
  };
  const report = markdown(metadata, analysis, caches);

  await mkdir("focused-results", { recursive: true });
  await writeFile(
    "focused-results/results.json",
    `${JSON.stringify({ metadata, analysis, caches }, null, 2)}\n`,
  );
  await writeFile(
    "focused-results/results.csv",
    `sample,arm,slot,seconds\n${rows
      .map((row) =>
        [row.sample, row.arm, row.slot, row.seconds].map(csvValue).join(","),
      )
      .join("\n")}\n`,
  );
  await writeFile("focused-results/summary.md", report);
  await appendFile(env.GITHUB_STEP_SUMMARY, report);

  if (env.CLEANUP_CACHES === "true") {
    for (const cache of caches) {
      await api(`/repos/${owner}/${repo}/actions/caches/${cache.id}`, token, {
        method: "DELETE",
      });
    }
    console.log(`Deleted ${caches.length} focused benchmark caches`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
