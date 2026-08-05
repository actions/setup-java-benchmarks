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
export const VERSIONS = [
  { arm: "v1", label: "v1.4.4", caching: "none" },
  { arm: "v2", label: "v2.5.1", caching: "none" },
  { arm: "v3", label: "v3.14.1", caching: "pom.xml" },
  { arm: "v4", label: "v4.8.0", caching: "cache-dependency-path" },
  { arm: "v52", label: "v5.2.0", caching: "cache-dependency-path" },
  { arm: "v56", label: "v5.6.0", caching: "cache-dependency-path + wrapper" },
  { arm: "main", label: "main", caching: "cache-dependency-path + wrapper" },
];

const LABELS = new Map(VERSIONS.map((entry) => [entry.arm, entry.label]));

export const COHORTS = [
  {
    id: "uncached",
    label: "Uncached setup",
    arms: ["v1", "v2"],
    reference: "v2",
    note: "v1 and v2 do not restore Maven dependencies, so this comparison is not comparable with cached versions.",
  },
  {
    id: "dependency-cache",
    label: "Dependency cache",
    arms: ["v3", "v4", "v52"],
    reference: "v52",
    note: "v3 uses its older pom.xml cache-key strategy; compare it with caution. v4 and v5.2 share the controlled cache key.",
  },
  {
    id: "wrapper-cache",
    label: "Dependency plus wrapper cache",
    arms: ["v56", "main"],
    reference: "main",
    note: "Both versions restore the dependency and Maven Wrapper caches.",
  },
];

function analyzeCohort(rows, cohort) {
  return analyzeAgainstReference(
    rows.filter((row) => cohort.arms.includes(row.arm)),
    cohort.arms,
    cohort.reference,
  );
}

function correctCohort(analysis) {
  const adjusted = holmAdjust(
    analysis.comparisons.map((comparison) =>
      comparison.isReference ? null : comparison.pValue,
    ),
  );
  return {
    ...analysis,
    comparisons: analysis.comparisons.map((comparison, index) => ({
      ...comparison,
      adjustedPValue: adjusted[index],
      verdict: comparison.isReference
        ? "reference"
        : classify(comparison.interval, {
            noiseFloor: analysis.noiseFloorSeconds,
            pValue: adjusted[index],
          }),
    })),
  };
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
    `Durations are the warm restore path with a Maven cache already populated, measured inside the job at millisecond resolution. Differences are against \`${REFERENCE}\`.`,
    "",
    "## Comparable cohorts",
    "",
    "The versions have different setup contracts, so they are compared only within behaviorally comparable cohorts. Holm correction controls the family-wise error rate within each cohort. Cross-cohort timings are descriptive and must not be used to rank versions.",
  ];
  const rawRows = analysis.rawRows ?? [];
  for (const cohort of COHORTS) {
    const cohortResult = correctCohort(analyzeCohort(rawRows, cohort));
    lines.push(
      "",
      `### ${cohort.label}`,
      "",
      cohort.note,
      "",
      `| Version | Median (s) | Mean (s) | MAD (s) | vs ${LABELS.get(cohort.reference)} (s) | 95% CI | Holm-adjusted p | Verdict |`,
      "| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |",
    );
    for (const comparison of cohortResult.comparisons) {
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
        `| ${LABELS.get(comparison.arm)} | ${summary.medianSeconds.toFixed(3)} | ${summary.meanSeconds.toFixed(3)} | ${summary.madSeconds.toFixed(3)} | ${diff} | ${ci} | ${p} | ${comparison.verdict} |`,
      );
    }
    lines.push(
      "",
      `A/A control (${LABELS.get(cohort.reference)} against itself): **${cohortResult.control.verdict}**${cohortResult.control.interval ? ` at ${formatInterval(cohortResult.control.interval)}` : ""}.`,
    );
  }
  lines.push(
    "",
    `Harness noise floor: ${analysis.noiseFloorSeconds.toFixed(3)}s (median spread between a version's own two slots on one runner). A difference smaller than this is reported as \`within-noise\`; one whose interval includes zero is reported as \`inconclusive\` rather than as a number that looks like a result.`,
    "",
    `A/A control (\`${REFERENCE}\` against itself) reports **${control.verdict}**${control.interval ? ` at ${formatInterval(control.interval)}` : ""}. A healthy harness reports \`within-noise\` or \`inconclusive\` here; anything else means slot ordering is biasing results and the cohort tables above cannot be trusted.`,
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
    "Every caching version restores the same Maven entry, so the stored blob cannot bias the comparison. v3 predates `cache-dependency-path` and keys on `pom.xml`, so it necessarily uses its own entry; treat its difference with more caution than the rest.",
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
  analysis.rawRows = rows;

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
    `${JSON.stringify({ metadata, analysis: { ...analysis, rawRows: undefined, runners: undefined }, caches }, null, 2)}\n`,
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
