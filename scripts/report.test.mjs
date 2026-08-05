import assert from "node:assert/strict";
import test from "node:test";

import { analyzeAgainstReference, parseSamples } from "./paired.mjs";
import { VERSIONS, hashFilesSingle, markdown, sha256 } from "./report.mjs";

const ARMS = VERSIONS.map((entry) => entry.arm);
const ORDER = [...ARMS, ...[...ARMS].reverse()];

// One runner's worth of the mirrored sweep. `speed` scales every slot so that a
// slow runner stays slow across all versions, which is what the pairing removes.
function sweep(sample, speed, perVersionMs, drift = 0) {
  return ORDER.map((arm, index) => {
    const slot = index + 1;
    const elapsed = perVersionMs[arm] * speed + drift * index;
    return `"${sample}","${arm}","${slot}","${Math.round(elapsed)}"`;
  }).join("\n");
}

const flat = Object.fromEntries(ARMS.map((arm) => [arm, 3000]));

test("hashes benchmark cache markers", () => {
  assert.equal(
    sha256("benchmark\n"),
    "8f8dbecfd77ab2386b49d723c6b2474f2c22c246805fa0f677bbaf6e4f7bbbfe",
  );
  assert.equal(
    hashFilesSingle("main-microsoft-1-30462682067\n"),
    "f0c1009aeb8d8582a73a81f3b0146467ed727211971e4052fccd9b7d60817d8f",
  );
});

test("keeps only runners that measured every version twice", () => {
  const csv = [
    sweep(1, 1, flat),
    // A runner that stopped after the first few slots must be discarded rather
    // than contribute a difference computed from unbalanced slots.
    '"2","v1","1","3000"',
    '"2","v2","2","3000"',
  ].join("\n");
  const analysis = analyzeAgainstReference(parseSamples(csv), ARMS, "main");
  assert.deepEqual(
    analysis.runners.map((runner) => runner.sample),
    [1],
  );
});

test("removes between-runner speed differences", () => {
  // Runners differ by up to 3x, and every version is 500ms slower than main.
  // Pairing within a runner must recover 500ms regardless of the spread.
  const perVersion = {
    ...flat,
    v1: 3500,
    v2: 3500,
    v3: 3500,
    v4: 3500,
    v52: 3500,
    v56: 3500,
  };
  const csv = [1, 2, 3, 4, 5, 6]
    .map((sample) => sweep(sample, 0.5 + sample * 0.5, perVersion))
    .join("\n");
  const analysis = analyzeAgainstReference(parseSamples(csv), ARMS, "main");
  const v4 = analysis.comparisons.find((entry) => entry.arm === "v4");
  assert.ok(Math.abs(v4.differenceSeconds - 1.125) < 0.001);
  assert.equal(v4.verdict, "regression");
});

test("cancels linear drift across the job", () => {
  // Every version is identical, but the job gets steadily slower. The mirrored
  // order must absorb that so no version is reported as different from main.
  const csv = [1, 2, 3, 4, 5, 6]
    .map((sample) => sweep(sample, 1, flat, 40))
    .join("\n");
  const analysis = analyzeAgainstReference(parseSamples(csv), ARMS, "main");
  for (const comparison of analysis.comparisons) {
    assert.ok(Math.abs(comparison.differenceSeconds) < 1e-9);
  }
});

test("reports the reference against itself without a verdict", () => {
  const csv = [1, 2, 3, 4].map((sample) => sweep(sample, 1, flat)).join("\n");
  const analysis = analyzeAgainstReference(parseSamples(csv), ARMS, "main");
  const reference = analysis.comparisons.find((entry) => entry.arm === "main");
  assert.equal(reference.verdict, "reference");
  assert.equal(reference.interval, null);
});

test("renders a version table, a control and per-runner medians", () => {
  const csv = [1, 2, 3, 4]
    .map((sample) => sweep(sample, 1 + sample * 0.1, flat))
    .join("\n");
  const analysis = analyzeAgainstReference(parseSamples(csv), ARMS, "main");
  const report = markdown(
    { runId: "1", distribution: "temurin", javaVersion: "17" },
    analysis,
    [{ key: "setup-java-Linux-x64-maven-abc", sizeBytes: 60 * 1024 * 1024 }],
  );
  assert.match(report, /# setup-java version sweep/);
  assert.match(report, /\| v4\.8\.0 \|/);
  assert.match(report, /A\/A control/);
  assert.match(report, /Harness noise floor/);
  assert.match(report, /## Per-runner medians/);
  // v1 and v2 skip the dependency restore entirely, so ranking them against
  // main would compare different amounts of work.
  assert.match(report, /not comparable \(no caching\)/);
  assert.match(report, /setup-java-Linux-x64-maven-abc/);
});

test("discards a runner whose slots for one version disagree", () => {
  // Nine well-behaved runners and one whose v4 slots differ by seconds, which
  // means that runner stalled rather than measured. Which version a stall lands
  // on is arbitrary, so it must not reach the comparison.
  const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((sample) =>
    sweep(sample, 1, flat),
  );
  const stalled = ORDER.map((arm, index) => {
    const slot = index + 1;
    const elapsed = arm === "v4" && slot === 4 ? 12000 : 3000;
    return `"10","${arm}","${slot}","${elapsed}"`;
  }).join("\n");
  const analysis = analyzeAgainstReference(
    parseSamples([...rows, stalled].join("\n")),
    ARMS,
    "main",
  );
  assert.deepEqual(
    analysis.droppedRunners.map((entry) => entry.sample),
    [10],
  );
  const v4 = analysis.comparisons.find((entry) => entry.arm === "v4");
  assert.ok(Math.abs(v4.differenceSeconds) < 1e-9);
  assert.equal(v4.verdict, "inconclusive");
});
