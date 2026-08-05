import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCacheIntegrity,
  decompose,
  markdown,
  parseSamples,
  subsetAnalysis,
  toPairedRows,
} from "./report-action-overhead.mjs";

function csv(rows) {
  return rows
    .map(
      ({ os, cache, layout, arm, slot, cacheHit, ms }) =>
        `"${os}","${cache}","${layout}","${arm}","${slot}","${cacheHit}","${ms}"`,
    )
    .join("\n");
}

function matrix({ shift = 0 } = {}) {
  const rows = [];
  const base = {
    none: 2000,
    "maven-miss": 2400,
    "maven-hit": 3100,
    "gradle-miss": 2380,
  };
  for (const os of ["ubuntu-latest", "macos-15-intel"]) {
    for (const cache of Object.keys(base)) {
      for (const layout of ["simple", "complex"]) {
        const hit =
          cache === "maven-hit"
            ? "true"
            : cache === "maven-miss"
              ? "false"
              : "unset";
        const offset = layout === "complex" ? 300 : 0;
        const drift = os === "macos-15-intel" ? 900 : 0;
        const at = base[cache] + offset + drift;
        rows.push(
          {
            os,
            cache,
            layout,
            arm: "baseline",
            slot: 1,
            cacheHit: hit,
            ms: at,
          },
          {
            os,
            cache,
            layout,
            arm: "candidate",
            slot: 2,
            cacheHit: hit,
            ms: at + shift,
          },
          {
            os,
            cache,
            layout,
            arm: "candidate",
            slot: 3,
            cacheHit: hit,
            ms: at + shift,
          },
          {
            os,
            cache,
            layout,
            arm: "baseline",
            slot: 4,
            cacheHit: hit,
            ms: at,
          },
        );
      }
    }
  }
  return parseSamples(csv(rows));
}

test("parses quoted rows and converts milliseconds to seconds", () => {
  const rows = parseSamples(
    '"ubuntu-latest","maven-hit","simple","baseline","1","true","3100"',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seconds, 3.1);
  assert.equal(rows[0].configuration, "ubuntu-latest/maven-hit/simple");
});

test("treats each configuration as one block", () => {
  const { configurations, rows } = toPairedRows(matrix());
  assert.equal(configurations.length, 16);
  assert.equal(new Set(rows.map((row) => row.sample)).size, 16);
});

// The decomposition is the reason this scenario uses a tiny entry, so the
// arithmetic that produces it has to be pinned.
test("differences the cache profiles into named steps", () => {
  const { levels, steps } = decompose(matrix());
  const ubuntu = levels.find((level) => level.os === "ubuntu-latest");
  assert.equal(ubuntu.seconds.none, 2.15);
  assert.equal(ubuntu.seconds["maven-miss"], 2.55);

  const ubuntuSteps = steps.find((entry) => entry.os === "ubuntu-latest").steps;
  assert.match(ubuntuSteps[0].label, /asking the cache service/);
  assert.ok(Math.abs(ubuntuSteps[0].seconds - 0.4) < 1e-9);
  assert.ok(Math.abs(ubuntuSteps[1].seconds - 0.7) < 1e-9);
});

test("reports no difference when the arms are identical", () => {
  const analysis = subsetAnalysis(matrix(), () => true);
  assert.ok(["within-noise", "inconclusive"].includes(analysis.verdict));
});

test("differences candidate minus baseline, so a slower candidate is positive", () => {
  const analysis = subsetAnalysis(matrix({ shift: 500 }), () => true);
  assert.ok(analysis.interval.estimate > 0);
});

test("flags a hit profile that actually missed", () => {
  const rows = matrix().map((row) =>
    row.cache === "maven-hit" && row.os === "ubuntu-latest"
      ? { ...row, cacheHit: "false" }
      : row,
  );
  const problems = checkCacheIntegrity(rows);
  assert.ok(problems.length > 0);
  assert.ok(problems.every((problem) => problem.expected === "true"));
  assert.match(problems[0].reason, /did not do the work/);
});

// A ref too old to publish `cache-hit` cannot be verified, and silently passing
// it would let the decomposition be built out of slots that never restored.
test("flags an unverifiable slot separately from a wrong one", () => {
  const rows = matrix().map((row) =>
    row.cache === "maven-hit" ? { ...row, cacheHit: "unset" } : row,
  );
  const problems = checkCacheIntegrity(rows);
  assert.ok(problems.length > 0);
  assert.match(problems[0].reason, /does not publish/);
});

test("accepts a matrix where every profile behaved", () => {
  assert.deepEqual(checkCacheIntegrity(matrix()), []);
});

test("leads with the integrity failure when there is one", () => {
  const rows = matrix().map((row) =>
    row.cache === "maven-hit" ? { ...row, cacheHit: "false" } : row,
  );
  const rendered = markdown(
    {
      setupJavaRepository: "actions/setup-java",
      baselineRef: "main",
      candidateRef: "main",
      runId: "1",
    },
    subsetAnalysis(rows, () => true),
    [],
    [],
    decompose(rows),
    checkCacheIntegrity(rows),
    [],
  );
  assert.match(rendered, /## The cache did not behave as the profiles assume/);
  assert.ok(
    rendered.indexOf("did not behave") <
      rendered.indexOf("Does the candidate differ"),
  );
});

// Blank lines are what make the output render as markdown rather than as one
// run-on paragraph, so filtering them out has to stay impossible.
test("keeps the blank lines that separate sections", () => {
  const rows = matrix();
  const rendered = markdown(
    {
      setupJavaRepository: "actions/setup-java",
      baselineRef: "v4.8.0",
      candidateRef: "main",
      runId: "1",
    },
    subsetAnalysis(rows, () => true),
    [],
    [],
    decompose(rows),
    [],
    [{ arm: "baseline", indexBytes: "1", jsBytes: "2", files: "3" }],
  );
  assert.match(rendered, /\n\n## Where the time goes\n\n/);
  assert.match(rendered, /## Bundle size/);
});
