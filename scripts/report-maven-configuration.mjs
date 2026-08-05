// Cross-matrix report for the Maven configuration warm path.
//
// Unlike the other workflows, this one does not repeat one scenario across many
// runners. It runs 36 different configurations once each, so a single cell
// yields one paired difference and cannot support an interval on its own.
//
// Each configuration is instead treated as a block: the arms are compared within
// it, on the same runner, in ABBA order, and the resulting differences are pooled
// across the matrix. That answers the question this workflow actually asks —
// whether the candidate differs from the baseline across configurations — and it
// costs no extra jobs. Per-configuration numbers are still published, but as
// single observations with no verdict attached, because that is all they are.

import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { analyzePairs } from "./paired.mjs";
import { describeVerdict, formatInterval } from "./stats.mjs";

const RESULTS_DIR = ".benchmark-results";
const OUTPUT_DIR = "maven-config-results";

// os,cache,versions,toolchains,implementation,iteration,elapsedMs
export function parseConfigurationSamples(csv) {
  return csv
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [os, cache, versions, toolchains, arm, slot, elapsedMs] =
        line.split(",");
      return {
        configuration: `${os}/${cache}/${versions}/${toolchains}`,
        os,
        cache,
        versions,
        toolchains,
        arm,
        slot: Number(slot),
        seconds: Number(elapsedMs) / 1000,
      };
    });
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
  const files = entries.filter((entry) => entry.endsWith("timings.csv"));
  if (files.length === 0) {
    throw new Error(`No timings.csv files found in ${directory}`);
  }
  const contents = await Promise.all(
    files.sort().map((file) => readFile(join(directory, file), "utf8")),
  );
  return contents.join("\n");
}

function subsetAnalysis(rows, predicate) {
  const subset = rows.filter(predicate);
  if (subset.length === 0) return null;
  const { rows: paired } = toPairedRows(subset);
  const analysis = analyzePairs(paired, "baseline", "candidate");
  return analysis.pairs.length === 0 ? null : analysis;
}

export function markdown(metadata, overall, byOs, byCache, configurations) {
  const lines = [
    "# Maven configuration warm path",
    "",
    `Baseline \`${metadata.baselineRef}\` vs candidate \`${metadata.candidateRef}\` from \`${metadata.setupJavaRepository}\`, run ${metadata.runId}.`,
    "",
    `${configurations.length} configurations, each measured once in ABBA order on its own runner after a discarded warm-up slot. A configuration is a block: the arms are compared within it, and the differences are pooled across the matrix. No single configuration supports a verdict on its own, because one runner yields one difference.`,
    "",
    "## Verdict across all configurations",
    "",
    `**${describeVerdict(overall.verdict)}**`,
    "",
    `Pooled paired difference (candidate - baseline): **${formatInterval(overall.interval, { digits: 3 })}**.`,
    `Permutation p-value: ${overall.pValue.toFixed(3)}. Blocks: ${overall.pairs.length}.`,
    `Harness noise floor: ${overall.noiseFloorSeconds.toFixed(3)}s (median spread between an arm's own two slots within a configuration).`,
    "",
    `A/A control (baseline against itself) reports **${overall.control.verdict}** at ${formatInterval(overall.control.interval, { digits: 3 })}. A healthy harness reports \`within-noise\` or \`inconclusive\` here; anything else means slot ordering is biasing results and the verdict above cannot be trusted.`,
    "",
    overall.droppedRunners.length === 0
      ? "No configuration was discarded for a stalled slot."
      : `Discarded ${overall.droppedRunners.length} configuration(s) whose own arm disagreed with itself by more than ${overall.stallThresholdSeconds.toFixed(3)}s: ${overall.droppedRunners.map((entry) => `#${entry.sample}`).join(", ")}.`,
    "",
    "## By operating system",
    "",
    "| Group | Blocks | Difference (s) | 95% CI | p | Verdict |",
    "| --- | ---: | ---: | --- | ---: | --- |",
  ];
  for (const [label, analysis] of [...byOs, ...byCache]) {
    if (!analysis) {
      lines.push(`| ${label} | 0 | n/a | n/a | n/a | no data |`);
      continue;
    }
    lines.push(
      `| ${label} | ${analysis.pairs.length} | ${analysis.interval.estimate.toFixed(3)} | ${analysis.interval.low.toFixed(3)} to ${analysis.interval.high.toFixed(3)} | ${analysis.pValue.toFixed(3)} | ${analysis.verdict} |`,
    );
  }
  lines.push(
    "",
    "Groups with few blocks will report `inconclusive` even where the pooled result does not. That is the intended behaviour: a handful of configurations cannot resolve a small effect.",
    "",
    "## Per configuration",
    "",
    "Single observations. No interval is quoted because one runner cannot support one.",
    "",
    "| Configuration | baseline (s) | candidate (s) | Difference (s) |",
    "| --- | ---: | ---: | ---: |",
  );
  for (const pair of overall.pairs) {
    lines.push(
      `| ${configurations[pair.sample - 1]} | ${pair.baseline.toFixed(3)} | ${pair.candidate.toFixed(3)} | ${pair.difference.toFixed(3)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function main(env = process.env) {
  const rows = parseConfigurationSamples(await readResults());
  const { configurations, rows: paired } = toPairedRows(rows);
  const overall = analyzePairs(paired, "baseline", "candidate");
  if (overall.pairs.length === 0) {
    throw new Error("No configuration completed all four slots");
  }

  const operatingSystems = [...new Set(rows.map((row) => row.os))].sort();
  const caches = [...new Set(rows.map((row) => row.cache))].sort();
  const byOs = operatingSystems.map((os) => [
    os,
    subsetAnalysis(rows, (row) => row.os === os),
  ]);
  const byCache = caches.map((cache) => [
    `cache: ${cache}`,
    subsetAnalysis(rows, (row) => row.cache === cache),
  ]);

  const metadata = {
    runId: env.GITHUB_RUN_ID,
    setupJavaRepository: env.SETUP_JAVA_REPOSITORY,
    baselineRef: env.BASELINE_REF,
    candidateRef: env.CANDIDATE_REF,
    generatedAt: new Date().toISOString(),
  };

  const report = markdown(metadata, overall, byOs, byCache, configurations);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(
    `${OUTPUT_DIR}/results.json`,
    `${JSON.stringify({ metadata, overall, configurations }, null, 2)}\n`,
  );
  await writeFile(`${OUTPUT_DIR}/summary.md`, report);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, report);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
