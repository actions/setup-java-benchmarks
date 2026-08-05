import assert from "node:assert/strict";
import test from "node:test";

import {
  analyze,
  buildPairs,
  markdown,
  noiseFloor,
  parseSamples,
} from "./report-focused.mjs";

const csv = [
  '"1","baseline","1","2400"',
  '"1","candidate","2","1900"',
  '"1","candidate","3","1950"',
  '"1","baseline","4","2500"',
  '"2","baseline","1","3100"',
  '"2","candidate","2","2600"',
  '"2","candidate","3","2500"',
  '"2","baseline","4","3000"',
].join("\n");

test("parses millisecond samples into seconds", () => {
  const rows = parseSamples(csv);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[0], {
    sample: 1,
    arm: "baseline",
    slot: 1,
    seconds: 2.4,
  });
});

test("pairs the two slots per arm within a runner", () => {
  const pairs = buildPairs(parseSamples(csv));
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].baseline, 2.45);
  assert.ok(Math.abs(pairs[0].candidate - 1.925) < 1e-9);
  assert.ok(Math.abs(pairs[0].difference - -0.525) < 1e-9);
  // Slot 4 minus slot 1 for the same implementation is a null measurement.
  assert.ok(Math.abs(pairs[0].baselineRepeatDelta - 0.1) < 1e-9);
});

test("drops runners with incomplete ABBA slots", () => {
  const partial = ['"3","baseline","1","2000"', '"3","candidate","2","1900"'];
  const pairs = buildPairs(parseSamples([csv, ...partial].join("\n")));
  assert.equal(pairs.length, 2);
  assert.ok(!pairs.some((pair) => pair.sample === 3));
});

test("derives the noise floor from within-arm repeats", () => {
  const pairs = buildPairs(parseSamples(csv));
  assert.ok(noiseFloor(pairs) > 0);
  assert.equal(noiseFloor([]), 0);
});

test("reports a large consistent improvement", () => {
  const rows = [];
  for (let sample = 1; sample <= 10; sample += 1) {
    // Each runner has its own offset, exactly the between-runner variance that
    // pairing is meant to remove.
    const offset = sample * 400;
    rows.push(
      `"${sample}","baseline","1","${3000 + offset}"`,
      `"${sample}","candidate","2","${2000 + offset}"`,
      `"${sample}","candidate","3","${2020 + offset}"`,
      `"${sample}","baseline","4","${3020 + offset}"`,
    );
  }
  const analysis = analyze(parseSamples(rows.join("\n")));
  assert.equal(analysis.verdict, "improvement");
  assert.ok(analysis.interval.high < 0);
  assert.ok(analysis.pValue < 0.01);
  // The control compares baseline against itself and must find nothing.
  assert.ok(
    ["within-noise", "inconclusive"].includes(analysis.control.verdict),
  );
});

test("renders a report with a verdict and paired samples", () => {
  const analysis = analyze(parseSamples(csv));
  const report = markdown(
    {
      runId: "1",
      javaVersion: "17.0.19+10",
      setupJavaRepository: "actions/setup-java",
      baselineRef: "v4.8.0",
      candidateRef: "main",
    },
    analysis,
    [{ arm: "baseline", type: "maven-dependencies", sizeBytes: 1024 * 1024 }],
  );
  assert.match(report, /# Focused cache restore benchmark/);
  assert.match(report, /## Verdict/);
  assert.match(report, /95% CI/);
  assert.match(report, /A\/A control/);
  assert.match(report, /Harness noise floor/);
});

test("reports an A/A comparison as inconclusive", () => {
  const jitter = [120, -90, 200, -160, 70, -110, 180, -140, 60, -50];
  const rows = [];
  for (let sample = 1; sample <= 10; sample += 1) {
    const offset = sample * 350;
    const wobble = jitter[sample - 1];
    rows.push(
      `"${sample}","baseline","1","${2500 + offset}"`,
      `"${sample}","candidate","2","${2500 + offset + wobble}"`,
      `"${sample}","candidate","3","${2500 + offset - wobble}"`,
      `"${sample}","baseline","4","${2500 + offset}"`,
    );
  }
  const analysis = analyze(parseSamples(rows.join("\n")));
  assert.notEqual(analysis.verdict, "improvement");
  assert.notEqual(analysis.verdict, "regression");
});
