import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { hashFilesSingle } from "./report.mjs";
import {
  analyzePairs,
  parseSamples,
  readSampleFiles as readPairedSampleFiles,
  requireEnv,
} from "./paired.mjs";
import { describeVerdict, formatInterval } from "./stats.mjs";

export function readSampleFiles(directory) {
  return readPairedSampleFiles("cache-value-timings", directory);
}

// The difference is cached minus uncached, so the cache saving time reads as a
// negative number and an `improvement`, the same direction every other workflow
// in this repository uses for the arm under test.
export function analyze(rows) {
  return analyzePairs(rows, "uncached", "cached");
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

// The saving is quoted as a ratio as well as a difference because the difference
// alone is not portable: it is a property of this dependency tree on this
// runner, and a reader comparing it with their own project needs to know
// whether the cache removed most of the work or a little of it.
function speedup(analysis) {
  const uncached = analysis.baseline.meanSeconds;
  const cached = analysis.candidate.meanSeconds;
  if (cached <= 0) return null;
  return uncached / cached;
}

export function markdown(metadata, analysis, caches) {
  const { baseline, candidate, interval, control } = analysis;
  const ratio = speedup(analysis);
  const lines = [
    "# Maven cache value",
    "",
    `Temurin ${metadata.javaVersion}, ${analysis.pairs.length} runners x 2 paired observations, run ${metadata.runId}.`,
    `\`${metadata.setupJavaRef}\` from \`${metadata.setupJavaRepository}\`, resolving Spring PetClinic.`,
    "",
    "Both arms run the same `dependency:go-offline` against the same dependency",
    "tree. They differ only in whether setup-java restored the local repository",
    "first, so the difference between them is what the cache is worth on this",
    "project rather than a detail of how the cache is implemented.",
    "",
    "## Verdict",
    "",
    `**${describeVerdict(analysis.verdict)}**`,
    "",
    `Time to a resolvable project, cached minus uncached: **${formatInterval(interval, { digits: 2 })}**.`,
    ratio === null
      ? null
      : `That is **${ratio.toFixed(1)}x faster** with the cache: ${baseline.meanSeconds.toFixed(1)}s without it, ${candidate.meanSeconds.toFixed(1)}s with it.`,
    `Permutation p-value: ${analysis.pValue.toFixed(3)}. Hodges-Lehmann shift: ${analysis.shiftSeconds.toFixed(2)}s.`,
    `Harness noise floor: ${analysis.noiseFloorSeconds.toFixed(2)}s (median within-runner repeat spread).`,
    "",
    `A/A control (the uncached arm against itself) reports **${control.verdict}** at ${formatInterval(control.interval, { digits: 2 })}. A healthy harness reports \`within-noise\` or \`inconclusive\` here; anything else means slot ordering is biasing results and the verdict above cannot be trusted.`,
    "",
    analysis.droppedRunners.length === 0
      ? "No runner was discarded for a stalled slot."
      : `Discarded ${analysis.droppedRunners.length} runner(s) whose own arm disagreed with itself by more than ${analysis.stallThresholdSeconds.toFixed(2)}s: ${analysis.droppedRunners.map((entry) => `#${entry.sample} (${entry.repeatSpread.toFixed(2)}s)`).join(", ")}. A stalled slot lands on an arbitrary arm and would otherwise dominate the mean.`,
    "",
    "## Arms",
    "",
    "| Arm | Runners | Mean (s) | Median (s) | SD (s) | MAD (s) | p95 (s) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| uncached | ${baseline.samples} | ${baseline.meanSeconds.toFixed(2)} | ${baseline.medianSeconds.toFixed(2)} | ${baseline.standardDeviationSeconds?.toFixed(2) ?? "n/a"} | ${baseline.madSeconds.toFixed(2)} | ${baseline.p95Seconds.toFixed(2)} |`,
    `| cached | ${candidate.samples} | ${candidate.meanSeconds.toFixed(2)} | ${candidate.medianSeconds.toFixed(2)} | ${candidate.standardDeviationSeconds?.toFixed(2) ?? "n/a"} | ${candidate.madSeconds.toFixed(2)} | ${candidate.p95Seconds.toFixed(2)} |`,
    "",
    "The uncached arm is the more variable of the two by a wide margin, because it",
    "depends on Maven Central rather than on the Actions cache service. That",
    "variance is real and belongs in the number: it is what a user without a cache",
    "actually experiences.",
    "",
    "## Paired samples",
    "",
    "| Runner | cached slot 1 (s) | uncached slot 2 (s) | uncached slot 3 (s) | cached slot 4 (s) | Paired delta (s) |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const pair of analysis.pairs) {
    lines.push(
      `| ${pair.sample} | ${pair.candidateSlots[0].toFixed(2)} | ${pair.baselineSlots[0].toFixed(2)} | ${pair.baselineSlots[1].toFixed(2)} | ${pair.candidateSlots[1].toFixed(2)} | ${pair.difference.toFixed(2)} |`,
    );
  }
  lines.push("", "## Caches", "", "| Cache | Size (MiB) |", "| --- | ---: |");
  for (const cache of caches) {
    lines.push(
      `| \`${cache.key}\` | ${(cache.sizeBytes / (1024 * 1024)).toFixed(1)} |`,
    );
  }
  // Only the optional ratio line is dropped. Filtering on "" instead would
  // collapse every intentional blank line and destroy the markdown structure.
  return `${lines.filter((line) => line !== null).join("\n")}\n`;
}

export async function main(env = process.env) {
  requireEnv(env, [
    "GH_TOKEN",
    "GITHUB_RUN_ID",
    "SETUP_JAVA_REPOSITORY",
    "SETUP_JAVA_REF",
    "GITHUB_REPOSITORY",
  ]);
  const token = env.GH_TOKEN;
  const runId = env.GITHUB_RUN_ID;
  const setupJavaRepository = env.SETUP_JAVA_REPOSITORY;
  const setupJavaRef = env.SETUP_JAVA_REF;
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
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
  // Only the dependency entry is identified here. The wrapper entry is keyed on
  // PetClinic's own wrapper properties, which this benchmark does not modify, so
  // it is shared with every other run and must not be deleted by one of them.
  const dependencyKey = `setup-java-Linux-x64-maven-${hashFilesSingle(
    `cache-value-${runId}\n`,
  )}`;
  const entry = cacheEntries.find((cache) => cache.key === dependencyKey);
  if (!entry) {
    throw new Error(`Expected cache not found: ${dependencyKey}`);
  }
  const caches = [
    { key: dependencyKey, id: entry.id, sizeBytes: entry.size_in_bytes },
  ];

  const metadata = {
    repository: env.GITHUB_REPOSITORY,
    runId,
    javaVersion: env.JAVA_VERSION,
    setupJavaRepository,
    setupJavaRef,
    generatedAt: new Date().toISOString(),
  };
  const report = markdown(metadata, analysis, caches);

  await mkdir("cache-value-results", { recursive: true });
  await writeFile(
    "cache-value-results/results.json",
    `${JSON.stringify({ metadata, analysis, caches }, null, 2)}\n`,
  );
  await writeFile(
    "cache-value-results/results.csv",
    `sample,arm,slot,seconds\n${rows
      .map((row) =>
        [row.sample, row.arm, row.slot, row.seconds].map(csvValue).join(","),
      )
      .join("\n")}\n`,
  );
  await writeFile("cache-value-results/summary.md", report);
  await appendFile(env.GITHUB_STEP_SUMMARY, report);

  if (env.CLEANUP_CACHES === "true") {
    for (const cache of caches) {
      await api(`/repos/${owner}/${repo}/actions/caches/${cache.id}`, token, {
        method: "DELETE",
      });
    }
    console.log(`Deleted ${caches.length} cache value benchmark caches`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
