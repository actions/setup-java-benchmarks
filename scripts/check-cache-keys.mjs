// Asserts the properties a cache key has to have, rather than measuring how
// long anything takes.
//
// The rest of this repository measures differences of tens or hundreds of
// milliseconds between implementations of the cache. None of that matters if the
// key misses: on Spring PetClinic a miss costs about a minute, which is three
// orders of magnitude more than the effects the timing benchmarks resolve. A
// key is also a deterministic function of the tree, so these properties can be
// asserted outright instead of estimated with an interval.

import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { requireEnv } from "./paired.mjs";

export function parseKeys(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [platform, replica, probe, key] = line
        .split('","')
        .map((field) => field.replace(/^"|"$/g, ""));
      return { platform, replica, probe, key };
    });
}

export async function readKeyFiles(directory = ".benchmark-results") {
  const entries = await readdir(directory);
  const files = entries.filter((name) => name.startsWith("cache-keys-"));
  const contents = await Promise.all(
    files.map((name) => readFile(join(directory, name), "utf8")),
  );
  return contents.join("\n");
}

function lookup(rows, platform, replica, probe) {
  return rows.find(
    (row) =>
      row.platform === platform &&
      row.replica === replica &&
      row.probe === probe,
  );
}

// Each check states the user-visible consequence of failing it, because a bare
// "keys differ" tells a maintainer nothing about whether to care.
const WITHIN_RUNNER = [
  {
    probe: "repeat",
    against: "baseline",
    expect: "same",
    title: "Repeating the same setup computes the same key",
    consequence:
      "the key is not a function of the tree, so a second run in the same job would miss",
  },
  {
    probe: "unrelated",
    against: "baseline",
    expect: "same",
    title: "Editing a source file does not change the key",
    consequence:
      "every commit that touches source would miss, which is the most common way caching is silently lost",
  },
  {
    probe: "dependency",
    against: "baseline",
    expect: "different",
    title: "Editing the dependency manifest changes the key",
    consequence:
      "a build whose dependencies changed would restore a stale repository",
  },
];

export function evaluate(rows) {
  const platforms = [...new Set(rows.map((row) => row.platform))].sort();
  const checks = [];

  for (const platform of platforms) {
    const replicas = [
      ...new Set(
        rows.filter((r) => r.platform === platform).map((r) => r.replica),
      ),
    ].sort();

    for (const replica of replicas) {
      for (const spec of WITHIN_RUNNER) {
        const left = lookup(rows, platform, replica, spec.probe);
        const right = lookup(rows, platform, replica, spec.against);
        checks.push(
          compare({
            ...spec,
            scope: `${platform} runner ${replica}`,
            left,
            right,
          }),
        );
      }
    }

    // The check that matters most: two runners in the same run, same tree, same
    // platform. If these disagree, caching never works at all - every job
    // computes a key no other job has stored.
    if (replicas.length >= 2) {
      for (const probe of ["baseline", "explicit"]) {
        checks.push(
          compare({
            probe,
            against: probe,
            expect: "same",
            title: `Two runners compute the same \`${probe}\` key`,
            consequence:
              "the key depends on something outside the tree, so no job would ever restore what another job stored",
            scope: platform,
            left: lookup(rows, platform, replicas[0], probe),
            right: lookup(rows, platform, replicas[1], probe),
          }),
        );
      }
    }
  }

  // A key is scoped to the platform it was built on, so two platforms must not
  // collide: restoring a Linux tree onto Windows would be worse than a miss.
  if (platforms.length >= 2) {
    for (let i = 0; i < platforms.length - 1; i += 1) {
      checks.push(
        compare({
          probe: "baseline",
          against: "baseline",
          expect: "different",
          title: `\`${platforms[i]}\` and \`${platforms[i + 1]}\` do not share a key`,
          consequence:
            "one platform could restore an entry another platform stored",
          scope: "cross-platform",
          left: lookup(rows, platforms[i], "1", "baseline"),
          right: lookup(rows, platforms[i + 1], "1", "baseline"),
        }),
      );
    }
  }

  return { checks, passed: checks.every((check) => check.passed) };
}

function compare({ title, consequence, expect, scope, left, right }) {
  // An absent or empty key is always a failure. Treating it as "equal to the
  // other empty key" would let a version that computes no key at all pass every
  // sameness check in this file.
  if (!left?.key || !right?.key) {
    return {
      title,
      scope,
      expect,
      passed: false,
      detail: "setup-java reported no cache-primary-key for at least one probe",
      consequence,
    };
  }
  const same = left.key === right.key;
  const passed = expect === "same" ? same : !same;
  return {
    title,
    scope,
    expect,
    passed,
    detail: same
      ? `both \`${left.key}\``
      : `\`${left.key}\` vs \`${right.key}\``,
    consequence,
  };
}

export function markdown(metadata, result) {
  const failed = result.checks.filter((check) => !check.passed);
  const lines = [
    "# Cache key stability",
    "",
    `\`${metadata.setupJavaRef}\` from \`${metadata.setupJavaRepository}\`, run ${metadata.runId}.`,
    "",
    "This is not a timing benchmark. The cache key is a deterministic function of",
    "the tree, so its properties are asserted rather than estimated. They matter",
    "more than any of the timings: a key that changes when it should not costs a",
    "full cache miss, which on this project is about a minute, while the timing",
    "benchmarks resolve effects of tens of milliseconds.",
    "",
    "## Result",
    "",
    result.passed
      ? `**All ${result.checks.length} checks passed.**`
      : `**${failed.length} of ${result.checks.length} checks failed.**`,
    "",
    "| Check | Scope | Expected | Result | Keys |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const check of result.checks) {
    lines.push(
      `| ${check.title} | ${check.scope} | ${check.expect} | ${check.passed ? "pass" : "**fail**"} | ${check.detail} |`,
    );
  }
  if (failed.length > 0) {
    lines.push("", "## What each failure costs", "");
    for (const check of failed) {
      lines.push(
        `- **${check.title}** (${check.scope}): ${check.consequence}.`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function main(env = process.env) {
  requireEnv(env, ["GITHUB_RUN_ID", "SETUP_JAVA_REPOSITORY", "SETUP_JAVA_REF"]);
  const metadata = {
    runId: env.GITHUB_RUN_ID,
    setupJavaRepository: env.SETUP_JAVA_REPOSITORY,
    setupJavaRef: env.SETUP_JAVA_REF,
    generatedAt: new Date().toISOString(),
  };
  const rows = parseKeys(await readKeyFiles());
  if (rows.length === 0) {
    throw new Error("No cache keys were collected");
  }
  const result = evaluate(rows);
  const report = markdown(metadata, result);

  await mkdir("cache-key-results", { recursive: true });
  await writeFile(
    "cache-key-results/results.json",
    `${JSON.stringify({ metadata, rows, result }, null, 2)}\n`,
  );
  await writeFile("cache-key-results/summary.md", report);
  await appendFile(env.GITHUB_STEP_SUMMARY, report);

  if (!result.passed) {
    throw new Error(
      `${result.checks.filter((check) => !check.passed).length} cache key checks failed`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
