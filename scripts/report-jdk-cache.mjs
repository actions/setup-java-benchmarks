import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { analyzePairs, parseSamples, readSampleFiles } from "./paired.mjs";
import { describeVerdict, formatInterval } from "./stats.mjs";

const API_VERSION = "2022-11-28";
const RESULTS_DIR = "jdk-cache-results";

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
    "# JDK cache benchmark",
    "",
    `${metadata.distribution} ${metadata.javaVersion}, ${analysis.pairs.length} runners x 2 paired observations, run ${metadata.runId}.`,
    `\`cache-jdk: false\` vs \`cache-jdk: true\` using \`${metadata.setupJavaRef}\` from \`${metadata.setupJavaRepository}\`.`,
    "",
    "The runner tool cache is purged before every measured slot, so each setup",
    "resolves the JDK the way a runner image without it would.",
    "",
    "## Verdict",
    "",
    `**${describeVerdict(analysis.verdict)}**`,
    "",
    `Paired difference (\`cache-jdk: true\` - \`cache-jdk: false\`): **${formatInterval(interval)}**.`,
    `Permutation p-value: ${analysis.pValue.toFixed(3)}. Hodges-Lehmann shift: ${analysis.shiftSeconds.toFixed(3)}s.`,
    `Harness noise floor: ${analysis.noiseFloorSeconds.toFixed(3)}s (median within-runner repeat spread).`,
    "",
    `A/A control (\`cache-jdk: false\` against itself) reports **${control.verdict}** at ${formatInterval(control.interval)}. A healthy harness reports \`within-noise\` or \`inconclusive\` here; an \`improvement\` or \`regression\` means slot ordering is biasing results and the verdict above cannot be trusted.`,
    "",
    "## Arms",
    "",
    "| Arm | Runners | Mean (s) | Median (s) | SD (s) | MAD (s) | p95 (s) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [label, arm] of [
    ["cache-jdk: false", baseline],
    ["cache-jdk: true", candidate],
  ]) {
    lines.push(
      `| \`${label}\` | ${arm.samples} | ${arm.meanSeconds.toFixed(3)} | ${arm.medianSeconds.toFixed(3)} | ${arm.standardDeviationSeconds.toFixed(3)} | ${arm.madSeconds.toFixed(3)} | ${arm.p95Seconds.toFixed(3)} |`,
    );
  }
  lines.push(
    "",
    "All durations are measured inside the job with millisecond resolution. The Actions API reports step timestamps only to the nearest second, which is too coarse for effects of this size.",
    "",
    "## Paired samples",
    "",
    "| Runner | no-cache slot 1 (s) | cache slot 2 (s) | cache slot 3 (s) | no-cache slot 4 (s) | Paired delta (s) |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const pair of analysis.pairs) {
    lines.push(
      `| ${pair.sample} | ${pair.baselineSlots[0].toFixed(3)} | ${pair.candidateSlots[0].toFixed(3)} | ${pair.candidateSlots[1].toFixed(3)} | ${pair.baselineSlots[1].toFixed(3)} | ${pair.difference.toFixed(3)} |`,
    );
  }
  lines.push(
    "",
    "## Caches",
    "",
    "Both arms restore the same Maven entry, so the stored blob cannot bias the comparison. Only the JDK entry differs between them.",
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
  if (!owner || !repo || !token || !runId) {
    throw new Error("Missing required GitHub Actions environment variables");
  }

  const rows = parseSamples(await readSampleFiles("jdk-cache-timings"));
  const analysis = analyzePairs(rows, "baseline", "candidate");
  if (analysis.pairs.length === 0) {
    throw new Error("No complete ABBA samples were collected");
  }

  const cacheEntries = await allPages(
    `/repos/${owner}/${repo}/actions/caches`,
    "actions_caches",
    token,
  );
  const caches = cacheEntries
    .filter(
      (entry) =>
        entry.key.startsWith("setup-java-jdk-") ||
        entry.key.startsWith("setup-java-Linux-x64-maven"),
    )
    .map((entry) => ({
      type: entry.key.startsWith("setup-java-jdk-") ? "jdk" : "maven",
      id: entry.id,
      key: entry.key,
      sizeBytes: entry.size_in_bytes,
    }));

  const metadata = {
    repository: env.GITHUB_REPOSITORY,
    runId,
    distribution: env.DISTRIBUTION,
    javaVersion: env.JAVA_VERSION,
    setupJavaRepository: env.SETUP_JAVA_REPOSITORY,
    setupJavaRef: env.SETUP_JAVA_REF,
    generatedAt: new Date().toISOString(),
  };

  const report = markdown(metadata, analysis, caches);
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    `${RESULTS_DIR}/results.json`,
    `${JSON.stringify({ metadata, analysis, caches }, null, 2)}\n`,
  );
  await writeFile(
    `${RESULTS_DIR}/results.csv`,
    `sample,arm,slot,seconds\n${rows
      .map((row) =>
        [row.sample, row.arm, row.slot, row.seconds].map(csvValue).join(","),
      )
      .join("\n")}\n`,
  );
  await writeFile(`${RESULTS_DIR}/summary.md`, report);
  await appendFile(env.GITHUB_STEP_SUMMARY, report);

  if (env.CLEANUP_CACHES === "true") {
    for (const cache of caches) {
      await api(`/repos/${owner}/${repo}/actions/caches/${cache.id}`, token, {
        method: "DELETE",
      });
    }
    console.log(`Deleted ${caches.length} JDK cache benchmark caches`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
