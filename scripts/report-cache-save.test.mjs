import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { analyze, markdown } from "./report-cache-save.mjs";
import { parseSamples } from "./paired.mjs";

function rowsFromSlots(slots) {
  return parseSamples(
    slots
      .map(([sample, b1, c2, c3, b4]) =>
        [
          `"${sample}","baseline","1","${b1}"`,
          `"${sample}","candidate","2","${c2}"`,
          `"${sample}","candidate","3","${c3}"`,
          `"${sample}","baseline","4","${b4}"`,
        ].join("\n"),
      )
      .join("\n"),
  );
}

test("analyzes cache-save samples with candidate minus baseline direction", () => {
  const slots = [];
  for (let sample = 1; sample <= 10; sample += 1) {
    const offset = sample * 250;
    slots.push([
      sample,
      2000 + offset,
      2600 + offset,
      2620 + offset,
      2020 + offset,
    ]);
  }
  const analysis = analyze(rowsFromSlots(slots));
  assert.equal(analysis.verdict, "regression");
  assert.ok(analysis.interval.low > 0);
  assert.ok(analysis.shiftSeconds > 0);
});

test("reports a large consistent saving as an improvement", () => {
  const slots = [];
  for (let sample = 1; sample <= 10; sample += 1) {
    const offset = sample * 300;
    slots.push([
      sample,
      3200 + offset,
      2100 + offset,
      2120 + offset,
      3220 + offset,
    ]);
  }
  const analysis = analyze(rowsFromSlots(slots));
  assert.equal(analysis.verdict, "improvement");
  assert.ok(analysis.interval.high < 0);
});

test("identical inputs do not produce a headline verdict", () => {
  const slots = [];
  for (let sample = 1; sample <= 10; sample += 1) {
    const offset = sample * 175;
    slots.push([
      sample,
      2400 + offset,
      2400 + offset,
      2400 + offset,
      2400 + offset,
    ]);
  }
  const analysis = analyze(rowsFromSlots(slots));
  assert.ok(["within-noise", "inconclusive"].includes(analysis.verdict));
  assert.ok(
    ["within-noise", "inconclusive"].includes(analysis.control.verdict),
  );
});

test("drops incomplete ABBA runners", () => {
  const rows = parseSamples(
    [
      '"1","baseline","1","2000"',
      '"1","candidate","2","1900"',
      '"1","candidate","3","1910"',
      '"1","baseline","4","2010"',
      '"2","baseline","1","2000"',
      '"2","candidate","2","1900"',
    ].join("\n"),
  );
  const analysis = analyze(rows);
  assert.equal(analysis.pairs.length, 1);
  assert.equal(analysis.pairs[0].sample, 1);
});

test("renders throughput, guard rails, and paired samples", () => {
  const analysis = analyze(
    rowsFromSlots([
      [1, 2400, 1900, 1950, 2500],
      [2, 3100, 2600, 2500, 3000],
    ]),
  );
  const report = markdown(
    {
      runId: "123",
      setupJavaRepository: "actions/setup-java",
      baselineRef: "v4.8.0",
      candidateRef: "main",
      fixtureMiB: 64,
      cacheKeyPrefix: "cache-save-123-",
    },
    analysis,
    [{ id: 1, key: "cache-save-123-1", sizeBytes: 64 * 1024 * 1024 }],
  );
  assert.match(report, /# Cache save benchmark/);
  assert.match(report, /Mean throughput \(MiB\/s\)/);
  assert.match(report, /A\/A control/);
  assert.match(report, /Paired samples/);
  assert.match(report, /@actions\/cache\.saveCache/);
  assert.match(report, /without .*including process startup/);
});

test("fixture verification asserts exact file count", async () => {
  const home = join(process.cwd(), ".cache-save-test-home");
  const env = { ...process.env, HOME: home };
  try {
    const prepare = spawnSync(
      "bash",
      ["scripts/cache-save.sh", "prepare-fixture", "1"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(prepare.status, 0, prepare.stderr);

    const expected = spawnSync(
      "bash",
      ["scripts/cache-save.sh", "expected-file-count", "1"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(expected.status, 0, expected.stderr);

    const actual = spawnSync("bash", ["scripts/cache-save.sh", "file-count"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(actual.stdout.trim(), expected.stdout.trim());

    const verify = spawnSync(
      "bash",
      ["scripts/cache-save.sh", "verify-fixture", "1"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(verify.status, 0, verify.stderr);

    const removeOne = spawnSync(
      "bash",
      ["scripts/cache-save.sh", "remove-one-file"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(removeOne.status, 0, removeOne.stderr);

    const failedVerify = spawnSync(
      "bash",
      ["scripts/cache-save.sh", "verify-fixture", "1"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.notEqual(failedVerify.status, 0);
    assert.match(failedVerify.stderr, /expected/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
