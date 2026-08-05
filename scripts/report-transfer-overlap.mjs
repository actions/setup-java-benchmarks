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
  analyzePairs,
  buildPairs,
  noiseFloor,
  parseSamples,
  readSampleFiles as readPairedSampleFiles,
  requireEnv,
} from "./paired.mjs";
import { classify, describeVerdict, formatInterval } from "./stats.mjs";

export { buildPairs, noiseFloor, parseSamples };

export function readSampleFiles(directory) {
  return readPairedSampleFiles("transfer-overlap-timings", directory);
}

export function analyze(rows) {
  return analyzePairs(rows, "baseline", "candidate");
}

const API_VERSION = "2022-11-28";

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
    "# Transfer overlap benchmark",
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
    analysis.droppedRunners.length === 0
      ? "No runner was discarded for a stalled slot."
      : `Discarded ${analysis.droppedRunners.length} runner(s) whose own arm disagreed with itself by more than ${analysis.stallThresholdSeconds.toFixed(3)}s, a threshold derived from the spread of the other runners: ${analysis.droppedRunners.map((entry) => `#${entry.sample} (${entry.repeatSpread.toFixed(3)}s)`).join(", ")}. A stalled slot lands on an arbitrary arm and would otherwise dominate the mean; the decision uses only within-arm spread, which carries no information about the effect.`,
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
  requireEnv(env, [
    "GITHUB_REPOSITORY",
    "GH_TOKEN",
    "GITHUB_RUN_ID",
    "BASELINE_REF",
    "CANDIDATE_REF",
    "SETUP_JAVA_REPOSITORY",
    "JAVA_VERSION",
  ]);

  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  const token = env.GH_TOKEN;
  const runId = env.GITHUB_RUN_ID;
  const baselineRef = env.BASELINE_REF;
  const candidateRef = env.CANDIDATE_REF;
  const setupJavaRepository = env.SETUP_JAVA_REPOSITORY;
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY must be owner/repo, got "${env.GITHUB_REPOSITORY}"`,
    );
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
  const benchmarkId = `transfer-overlap-${runId}`;
  const expected = [
    {
      type: "maven-dependencies",
      key: `setup-java-Linux-x64-maven-${hashFilesSingle(`${benchmarkId}\n`)}`,
      required: true,
    },
    {
      type: "maven-wrapper",
      key: `setup-java-Linux-x64-maven-wrapper-${hashFilesSingle(
        `wrapperVersion=overlap\n# benchmark-id=${benchmarkId}\n`,
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

  await mkdir("transfer-overlap-results", { recursive: true });
  await writeFile(
    "transfer-overlap-results/results.json",
    `${JSON.stringify({ metadata, analysis, caches }, null, 2)}\n`,
  );
  await writeFile(
    "transfer-overlap-results/results.csv",
    `sample,arm,slot,seconds\n${rows
      .map((row) =>
        [row.sample, row.arm, row.slot, row.seconds].map(csvValue).join(","),
      )
      .join("\n")}\n`,
  );
  await writeFile("transfer-overlap-results/summary.md", report);
  await appendFile(env.GITHUB_STEP_SUMMARY, report);

  if (env.CLEANUP_CACHES === "true") {
    for (const cache of caches) {
      await api(`/repos/${owner}/${repo}/actions/caches/${cache.id}`, token, {
        method: "DELETE",
      });
    }
    console.log(`Deleted ${caches.length} transfer-overlap benchmark caches`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
