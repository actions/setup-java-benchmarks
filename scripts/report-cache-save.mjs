import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  analyzePairs,
  parseSamples,
  readSampleFiles as readPairedSampleFiles,
  requireEnv,
} from "./paired.mjs";
import { describeVerdict, formatInterval } from "./stats.mjs";

const API_VERSION = "2022-11-28";

export function readSampleFiles(directory) {
  return readPairedSampleFiles("cache-save-timings", directory);
}

export function analyze(rows) {
  return analyzePairs(rows, "baseline", "candidate");
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function throughput(fixtureMiB, seconds) {
  return fixtureMiB / seconds;
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

export function markdown(metadata, analysis, caches = []) {
  const { baseline, candidate, interval, control } = analysis;
  const fixtureMiB = Number(metadata.fixtureMiB);
  const lines = [
    "# Cache save benchmark",
    "",
    `${fixtureMiB} MiB Maven fixture, ${analysis.pairs.length} runners x 2 paired observations, run ${metadata.runId}.`,
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
    "| Arm | Runners | Mean (s) | Median (s) | SD (s) | MAD (s) | p95 (s) | Mean throughput (MiB/s) | Median throughput (MiB/s) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const summary of [baseline, candidate]) {
    lines.push(
      `| ${summary.arm} | ${summary.samples} | ${summary.meanSeconds.toFixed(3)} | ${summary.medianSeconds.toFixed(3)} | ${summary.standardDeviationSeconds?.toFixed(3) ?? "n/a"} | ${summary.madSeconds.toFixed(3)} | ${summary.p95Seconds.toFixed(3)} | ${throughput(fixtureMiB, summary.meanSeconds).toFixed(1)} | ${throughput(fixtureMiB, summary.medianSeconds).toFixed(1)} |`,
    );
  }
  lines.push(
    "",
    "The fixture is byte-identical for every slot. Distinct keys are still required because a cache save for an existing key is a no-op; that creates fresh blobs whose placement can affect upload throughput, which is the dominant noise source for this scenario.",
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
    "## Cache entries",
    "",
    caches.length === 0
      ? "No matching cache entries were found when the report was generated."
      : `Found ${caches.length} cache entries with the run-scoped prefix \`${metadata.cacheKeyPrefix}\`.`,
    "",
    "All durations are measured inside the job with millisecond resolution by timing only the \`@actions/cache.saveCache\` call after Node has started and the module has loaded. setup-java delegates Maven cache transfers to that toolkit function, so this reports transfer-and-archive time without relying on post-job step timestamps from the Actions API or including process startup.",
  );
  return `${lines.filter((line) => line !== null).join("\n")}\n`;
}

export async function main(env = process.env) {
  requireEnv(env, [
    "GITHUB_REPOSITORY",
    "GH_TOKEN",
    "GITHUB_RUN_ID",
    "BASELINE_REF",
    "CANDIDATE_REF",
    "SETUP_JAVA_REPOSITORY",
    "FIXTURE_MIB",
    "CACHE_KEY_PREFIX",
    "GITHUB_STEP_SUMMARY",
  ]);

  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY must be owner/repo, got "${env.GITHUB_REPOSITORY}"`,
    );
  }

  const token = env.GH_TOKEN;
  const cacheEntries = await allPages(
    `/repos/${owner}/${repo}/actions/caches`,
    "actions_caches",
    token,
  );
  const caches = cacheEntries
    .filter((cache) => cache.key.startsWith(env.CACHE_KEY_PREFIX))
    .map((cache) => ({
      id: cache.id,
      key: cache.key,
      sizeBytes: cache.size_in_bytes,
    }));

  const metadata = {
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    setupJavaRepository: env.SETUP_JAVA_REPOSITORY,
    baselineRef: env.BASELINE_REF,
    candidateRef: env.CANDIDATE_REF,
    fixtureMiB: Number(env.FIXTURE_MIB),
    cacheKeyPrefix: env.CACHE_KEY_PREFIX,
    generatedAt: new Date().toISOString(),
  };

  try {
    const rows = parseSamples(await readSampleFiles());
    const analysis = analyze(rows);
    if (analysis.pairs.length === 0) {
      throw new Error("No complete ABBA samples were collected");
    }
    const report = markdown(metadata, analysis, caches);

    await mkdir("cache-save-results", { recursive: true });
    await writeFile(
      "cache-save-results/results.json",
      `${JSON.stringify({ metadata, analysis, caches }, null, 2)}\n`,
    );
    await writeFile(
      "cache-save-results/results.csv",
      `sample,arm,slot,seconds\n${rows
        .map((row) =>
          [row.sample, row.arm, row.slot, row.seconds].map(csvValue).join(","),
        )
        .join("\n")}\n`,
    );
    await writeFile("cache-save-results/summary.md", report);
    await appendFile(env.GITHUB_STEP_SUMMARY, report);
  } finally {
    const deletionFailures = [];
    let deleted = 0;
    for (const cache of caches) {
      try {
        await api(`/repos/${owner}/${repo}/actions/caches/${cache.id}`, token, {
          method: "DELETE",
        });
        deleted += 1;
      } catch (error) {
        deletionFailures.push(`${cache.key}: ${error.message}`);
      }
    }
    console.log(`Deleted ${deleted} cache-save benchmark caches`);
    if (deletionFailures.length > 0) {
      throw new Error(
        `Failed to delete ${deletionFailures.length} cache-save benchmark cache(s): ${deletionFailures.join("; ")}`,
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
