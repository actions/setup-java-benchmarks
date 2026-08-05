import assert from "node:assert/strict";
import test from "node:test";

import { analyzePairs, parseSamples } from "./paired.mjs";
import { markdown } from "./report-jdk-cache.mjs";

function abba(sample, noCache, cache) {
  return [
    `"${sample}","baseline","1","${noCache[0]}"`,
    `"${sample}","candidate","2","${cache[0]}"`,
    `"${sample}","candidate","3","${cache[1]}"`,
    `"${sample}","baseline","4","${noCache[1]}"`,
  ].join("\n");
}

const metadata = {
  runId: "1",
  distribution: "microsoft",
  javaVersion: "17",
  setupJavaRepository: "actions/setup-java",
  setupJavaRef: "main",
};

test("resolves a large consistent JDK cache saving", () => {
  // Restoring the JDK from the Actions cache instead of downloading it from the
  // vendor is a multi-second effect, so it must clear the noise floor.
  const csv = [
    abba(1, [21000, 21400], [9000, 9200]),
    abba(2, [23000, 22600], [10100, 9900]),
    abba(3, [20500, 20900], [8800, 9100]),
    abba(4, [24000, 23600], [11000, 10700]),
    abba(5, [22000, 22300], [9500, 9800]),
    abba(6, [21500, 21100], [9300, 9000]),
  ].join("\n");
  const analysis = analyzePairs(parseSamples(csv));
  assert.equal(analysis.pairs.length, 6);
  assert.equal(analysis.verdict, "improvement");
  assert.ok(analysis.interval.high < 0);
  assert.ok(analysis.interval.estimate < -11);
  assert.equal(analysis.control.verdict !== "improvement", true);
});

test("reports an unchanged configuration as inconclusive", () => {
  // Both arms behaving identically is the A/A case. The estimator must not
  // resolve an effect, whatever the runners happen to be doing.
  const csv = [
    abba(1, [9000, 9600], [9300, 9100]),
    abba(2, [12000, 11400], [11800, 12200]),
    abba(3, [8600, 9000], [8800, 8500]),
    abba(4, [15000, 14200], [14600, 15100]),
    abba(5, [10200, 10800], [10500, 10100]),
    abba(6, [9800, 9200], [9400, 9900]),
  ].join("\n");
  const analysis = analyzePairs(parseSamples(csv));
  assert.ok(["inconclusive", "within-noise"].includes(analysis.verdict));
});

test("drops runners that did not complete all four slots", () => {
  const csv = [
    abba(1, [21000, 21400], [9000, 9200]),
    '"2","baseline","1","21000"',
    '"2","candidate","2","9000"',
  ].join("\n");
  const analysis = analyzePairs(parseSamples(csv));
  assert.deepEqual(
    analysis.pairs.map((pair) => pair.sample),
    [1],
  );
});

test("renders a verdict, both arms and the paired samples", () => {
  const csv = [
    abba(1, [21000, 21400], [9000, 9200]),
    abba(2, [23000, 22600], [10100, 9900]),
  ].join("\n");
  const analysis = analyzePairs(parseSamples(csv));
  const report = markdown(metadata, analysis, [
    { type: "jdk", sizeBytes: 190 * 1024 * 1024 },
    { type: "maven", sizeBytes: 60 * 1024 * 1024 },
  ]);
  assert.match(report, /# JDK cache benchmark/);
  assert.match(report, /## Verdict/);
  assert.match(report, /cache-jdk: true/);
  assert.match(report, /A\/A control/);
  assert.match(report, /Harness noise floor/);
  assert.match(report, /\| jdk \| 190\.0 \|/);
  // One row per runner, so a reader can see the raw slots behind the interval.
  assert.match(report, /\| 1 \| 21\.000 \| 9\.000 \| 9\.200 \| 21\.400 \|/);
});
