import assert from "node:assert/strict";
import test from "node:test";

import { analyzePairs } from "./paired.mjs";
import {
  markdown,
  parseConfigurationSamples,
  toPairedRows,
} from "./report-maven-configuration.mjs";

const OSES = ["ubuntu-latest", "windows-latest", "macos-15-intel"];
const CACHES = ["none", "maven", "gradle"];

// One configuration's ABBA block. `speed` scales the whole runner so that a slow
// configuration stays slow across both arms, which is what the pairing removes.
function block(os, cache, speed, effectMs = 0) {
  const base = 4000 * speed;
  return [
    `${os},${cache},single,empty,baseline,1,${Math.round(base)}`,
    `${os},${cache},single,empty,candidate,2,${Math.round(base + effectMs)}`,
    `${os},${cache},single,empty,candidate,3,${Math.round(base + effectMs)}`,
    `${os},${cache},single,empty,baseline,4,${Math.round(base)}`,
  ].join("\n");
}

function matrix(effectMs) {
  const lines = [];
  OSES.forEach((os, osIndex) => {
    CACHES.forEach((cache, cacheIndex) => {
      lines.push(
        block(os, cache, 1 + osIndex * 0.8 + cacheIndex * 0.3, effectMs),
      );
    });
  });
  return lines.join("\n");
}

test("treats each configuration as one paired block", () => {
  const rows = parseConfigurationSamples(matrix(0));
  const { configurations, rows: paired } = toPairedRows(rows);
  assert.equal(configurations.length, 9);
  // Nine blocks of four slots each.
  assert.equal(paired.length, 36);
  assert.deepEqual(
    [...new Set(paired.map((row) => row.sample))].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test("pools a consistent effect across configurations", () => {
  // Every configuration is 500ms slower on the candidate, but the configurations
  // differ from each other by up to 3x. Pooling the within-block differences must
  // recover 500ms regardless of that spread.
  const { rows } = toPairedRows(parseConfigurationSamples(matrix(500)));
  const analysis = analyzePairs(rows, "baseline", "candidate");
  assert.ok(Math.abs(analysis.interval.estimate - 0.5) < 1e-9);
  assert.equal(analysis.verdict, "regression");
});

test("reports no effect when the arms are identical", () => {
  const { rows } = toPairedRows(parseConfigurationSamples(matrix(0)));
  const analysis = analyzePairs(rows, "baseline", "candidate");
  assert.ok(["inconclusive", "within-noise"].includes(analysis.verdict));
});

test("renders a pooled verdict, group breakdowns and per-configuration rows", () => {
  const rows = parseConfigurationSamples(matrix(500));
  const { configurations, rows: paired } = toPairedRows(rows);
  const overall = analyzePairs(paired, "baseline", "candidate");
  const report = markdown(
    {
      runId: "1",
      setupJavaRepository: "actions/setup-java",
      baselineRef: "v4.8.0",
      candidateRef: "main",
    },
    overall,
    [["ubuntu-latest", overall]],
    [["cache: maven", null]],
    configurations,
  );
  assert.match(report, /# Maven configuration warm path/);
  assert.match(report, /## Verdict across all configurations/);
  assert.match(report, /A\/A control/);
  assert.match(report, /Harness noise floor/);
  // A group with no usable data must say so rather than quote a number.
  assert.match(report, /\| cache: maven \| 0 \| n\/a \|/);
  assert.match(
    report,
    /No interval is quoted because one runner cannot support one/,
  );
});
