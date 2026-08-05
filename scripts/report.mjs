import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  analyzeAgainstReference,
  parseSamples,
  readSampleFiles,
  requireEnv,
} from "./paired.mjs";
import { classify, formatInterval, holmAdjust } from "./stats.mjs";

const API_VERSION = "2022-11-28";
const RESULTS_DIR = "results";
const REFERENCE = "main";

// Ordered oldest to newest. The warm sweep measures them in this order and then
// in reverse, so each version's two slots sit symmetrically about the middle of
// the job.
//
// `comparable` records whether a version can be ranked against the reference at
// all. A version is comparable only when it does the same work as `main` from
// the same stored blob; anything else is measuring a difference in the workload
// rather than in the implementation, and a verdict on it would mislead. Those
// versions are still measured and published, but descriptively.
export const VERSIONS = [
  {
    arm: "v1",
    label: "v1.4.4",
    caching: "none",
    comparable: false,
    reason:
      "installs its own JDK and does no dependency caching, so its duration is a different workload rather than the same work done differently",
  },
  {
    arm: "v2",
    label: "v2.5.1",
    caching: "none",
    comparable: false,
    reason:
      "its bundled cache client is rejected by the current cache service, so it restores nothing and skips the work the other versions spend their time on",
  },
  {
    arm: "v3",
    label: "v3.14.1",
    caching: "pom.xml",
    comparable: false,
    reason:
      "predates `cache-dependency-path` and therefore restores its own cache entry; a stored blob's throughput is fixed for the life of the entry, so this difference is confounded with blob placement and pairing cannot remove it",
  },
  {
    arm: "v4",
    label: "v4.8.0",
    caching: "cache-dependency-path",
    comparable: true,
  },
  {
    arm: "v52",
    label: "v5.2.0",
    caching: "cache-dependency-path",
    comparable: true,
  },
  {
    arm: "v56",
    label: "v5.6.0",
    caching: "cache-dependency-path + wrapper",
    comparable: true,
  },
  {
    arm: "main",
    label: "main",
    caching: "cache-dependency-path + wrapper",
    comparable: true,
  },
];

const LABELS = new Map(VERSIONS.map((entry) => [entry.arm, entry.label]));

export const COMPARABLE_ARMS = VERSIONS.filter((entry) => entry.comparable).map(
  (entry) => entry.arm,
);

// Holm's step-down correction is applied across the comparable family only.
// Every version in it is tested against the same reference in the same run, so
// without a correction the chance that at least one of them clears 0.05 by luck
// is far higher than 0.05. The descriptive versions are excluded because they
// carry no verdict to correct.
export function correctFamily(analysis) {
  const adjusted = holmAdjust(
    analysis.comparisons.map((comparison) =>
      comparison.isReference || !isComparable(comparison.arm)
        ? null
        : comparison.pValue,
    ),
  );
  return {
    ...analysis,
    comparisons: analysis.comparisons.map((comparison, index) => ({
      ...comparison,
      adjustedPValue: adjusted[index],
      verdict: comparison.isReference
        ? "reference"
        : !isComparable(comparison.arm)
          ? "not comparable"
          : classify(comparison.interval, {
              noiseFloor: analysis.noiseFloorSeconds,
              pValue: adjusted[index],
            }),
    })),
  };
}

function isComparable(arm) {
  return VERSIONS.find((entry) => entry.arm === arm)?.comparable === true;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashFilesSingle(value) {
  const contentHash = createHash("sha256").update(value).digest();
  return createHash("sha256").update(contentHash).digest("hex");
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
  const { control } = analysis;
  const lines = [
    "# setup-java version sweep",
    "",
    `${metadata.distribution} ${metadata.javaVersion}, ${analysis.runners.length} runners x 2 observations per version, run ${metadata.runId}.`,
    "",
    "Every version is measured in the same job, in the order v1..main followed by",
    "main..v1. Differencing within a runner removes between-runner variance, which",
    "on hosted runners is larger than the differences between versions. The mirrored",
    "order places each version's two slots symmetrically about the middle of the job,",
    "so drift across the job cancels.",
    "",
    `Durations are the warm restore path with a Maven cache already populated, measured inside the job at millisecond resolution.`,
    "",
    "## Versions ranked against `main`",
    "",
    "Only versions that do the same work as `main` from the same stored cache entry are ranked. Holm's step-down correction is applied across this family, because every version in it is tested against the same reference in the same run and without it the chance that one clears 0.05 by luck is far above 0.05.",
    "",
    `| Version | Caching | Median (s) | Mean (s) | MAD (s) | vs ${REFERENCE} (s) | 95% CI | Holm-adjusted p | Verdict |`,
    "| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |",
  ];
  const corrected = correctFamily(analysis);
  const rankable = corrected.comparisons.filter((comparison) =>
    COMPARABLE_ARMS.includes(comparison.arm),
  );
  const descriptive = corrected.comparisons.filter(
    (comparison) => !COMPARABLE_ARMS.includes(comparison.arm),
  );
  for (const comparison of rankable) {
    const entry = VERSIONS.find((item) => item.arm === comparison.arm);
    const summary = comparison.summary;
    const diff = comparison.isReference
      ? "reference"
      : comparison.differenceSeconds.toFixed(3);
    const ci = comparison.interval
      ? `${comparison.interval.low.toFixed(3)} to ${comparison.interval.high.toFixed(3)}`
      : "n/a";
    const p =
      comparison.adjustedPValue === null
        ? "n/a"
        : comparison.adjustedPValue.toFixed(3);
    lines.push(
      `| ${LABELS.get(comparison.arm)} | ${entry.caching} | ${summary.medianSeconds.toFixed(3)} | ${summary.meanSeconds.toFixed(3)} | ${summary.madSeconds.toFixed(3)} | ${diff} | ${ci} | ${p} | ${comparison.verdict} |`,
    );
  }
  lines.push(
    "",
    "## Measured but not ranked",
    "",
    "These versions are measured on the same runners and in the same order, but they do not do the same work as `main`, so a verdict on them would report a difference in the workload as though it were a difference in the implementation. Their durations are published to show what the ranked versions are spending their time on.",
    "",
    "| Version | Caching | Median (s) | Mean (s) | MAD (s) | vs `main` (s) | Why it is not ranked |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  );
  for (const comparison of descriptive) {
    const entry = VERSIONS.find((item) => item.arm === comparison.arm);
    const summary = comparison.summary;
    lines.push(
      `| ${LABELS.get(comparison.arm)} | ${entry.caching} | ${summary.medianSeconds.toFixed(3)} | ${summary.meanSeconds.toFixed(3)} | ${summary.madSeconds.toFixed(3)} | ${comparison.differenceSeconds.toFixed(3)} | ${entry.reason} |`,
    );
  }
  lines.push(
    "",
    `Harness noise floor: ${analysis.noiseFloorSeconds.toFixed(3)}s (median spread between a version's own two slots on one runner). A difference smaller than this is reported as \`within-noise\`; one whose interval includes zero is reported as \`inconclusive\` rather than as a number that looks like a result.`,
    "",
    `A/A control (\`${REFERENCE}\` against itself) reports **${control.verdict}**${control.interval ? ` at ${formatInterval(control.interval)}` : ""}. A healthy harness reports \`within-noise\` or \`inconclusive\` here; anything else means slot ordering is biasing results and the table above cannot be trusted.`,
    "",
    analysis.droppedRunners.length === 0
      ? "No runner was discarded for a stalled slot."
      : `Discarded ${analysis.droppedRunners.length} runner(s) whose slots for one version disagreed with each other by more than ${analysis.stallThresholdSeconds.toFixed(3)}s, a threshold derived from the spread of the other runners: ${analysis.droppedRunners.map((entry) => `#${entry.sample}`).join(", ")}. The version a stall lands on is arbitrary, and the decision uses only within-version spread, which carries no information about the differences between versions.`,
    "",
    "## Per-runner medians",
    "",
    `| Runner | ${VERSIONS.map((entry) => entry.label).join(" | ")} |`,
    `| ---: | ${VERSIONS.map(() => "---:").join(" | ")} |`,
  );
  for (const runner of analysis.runners) {
    const cells = VERSIONS.map((entry) => {
      const slots = runner.slots.get(entry.arm) ?? [];
      if (slots.length === 0) return "n/a";
      return ((slots[0] + slots[1]) / 2).toFixed(3);
    });
    lines.push(`| ${runner.sample} | ${cells.join(" | ")} |`);
  }
  lines.push(
    "",
    "## Caches",
    "",
    "Every ranked version restores the same Maven entry, so the stored blob cannot bias the comparison between them. v3 predates `cache-dependency-path` and keys on `pom.xml`, so it necessarily restores its own entry; a blob's throughput is fixed for the life of the entry and identical on every runner, which is why v3 is measured but not ranked.",
    "",
    "v1 and v2 have no caching at all, so they skip the dependency restore entirely and their durations are not comparable with the rest. They are measured to show what the caching versions are spending their time on, not to be ranked against them.",
    "",
    "| Cache | Size (MiB) |",
    "| --- | ---: |",
  );
  for (const cache of caches) {
    lines.push(
      `| \`${cache.key}\` | ${(cache.sizeBytes / 1024 / 1024).toFixed(1)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function main(env = process.env) {
  requireEnv(env, [
    "GITHUB_REPOSITORY",
    "GH_TOKEN",
    "GITHUB_RUN_ID",
    "DISTRIBUTION",
    "JAVA_VERSION",
  ]);
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  const token = env.GH_TOKEN;
  const runId = env.GITHUB_RUN_ID;
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY must be owner/repo, got "${env.GITHUB_REPOSITORY}"`,
    );
  }

  const rows = parseSamples(await readSampleFiles("version-sweep"));
  const analysis = analyzeAgainstReference(
    rows,
    VERSIONS.map((entry) => entry.arm),
    REFERENCE,
  );
  if (analysis.runners.length === 0) {
    throw new Error("No runner measured every version twice");
  }

  const cacheEntries = await allPages(
    `/repos/${owner}/${repo}/actions/caches`,
    "actions_caches",
    token,
  );
  const caches = cacheEntries
    .filter((entry) => entry.key.startsWith("setup-java-"))
    .map((entry) => ({
      id: entry.id,
      key: entry.key,
      sizeBytes: entry.size_in_bytes,
    }));

  const metadata = {
    repository: env.GITHUB_REPOSITORY,
    runId,
    distribution: env.DISTRIBUTION,
    javaVersion: env.JAVA_VERSION,
    generatedAt: new Date().toISOString(),
  };

  const report = markdown(metadata, analysis, caches);
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    `${RESULTS_DIR}/results.json`,
    `${JSON.stringify({ metadata, analysis: { ...analysis, runners: undefined }, caches }, null, 2)}\n`,
  );
  await writeFile(
    `${RESULTS_DIR}/results.csv`,
    `sample,version,slot,seconds\n${rows
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
    console.log(`Deleted ${caches.length} benchmark caches`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
