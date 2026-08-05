import assert from "node:assert/strict";
import test from "node:test";

import { evaluate, markdown, parseKeys } from "./check-cache-keys.mjs";

function rows(entries) {
  return parseKeys(
    entries
      .map(
        ({ platform, replica, probe, key }) =>
          `"${platform}","${replica}","${probe}","${key}"`,
      )
      .join("\n"),
  );
}

function healthy() {
  const out = [];
  for (const platform of ["linux", "windows"]) {
    for (const replica of ["1", "2"]) {
      const base = `setup-java-${platform}-maven-aaa`;
      out.push(
        { platform, replica, probe: "baseline", key: base },
        { platform, replica, probe: "repeat", key: base },
        { platform, replica, probe: "unrelated", key: base },
        {
          platform,
          replica,
          probe: "dependency",
          key: `setup-java-${platform}-maven-bbb`,
        },
        {
          platform,
          replica,
          probe: "explicit",
          key: `setup-java-${platform}-maven-ccc`,
        },
      );
    }
  }
  return rows(out);
}

test("passes a key that behaves correctly", () => {
  const result = evaluate(healthy());
  assert.equal(result.passed, true);
  assert.ok(result.checks.length > 0);
});

test("fails when a source edit changes the key", () => {
  const broken = healthy().map((row) =>
    row.probe === "unrelated" && row.platform === "linux"
      ? { ...row, key: "setup-java-linux-maven-zzz" }
      : row,
  );
  const result = evaluate(broken);
  assert.equal(result.passed, false);
  const failure = result.checks.find((check) => !check.passed);
  assert.match(failure.title, /source file/);
  assert.match(failure.consequence, /every commit/);
});

test("fails when two runners disagree on the same tree", () => {
  const broken = healthy().map((row) =>
    row.probe === "baseline" && row.replica === "2" && row.platform === "linux"
      ? { ...row, key: "setup-java-linux-maven-other" }
      : row,
  );
  const result = evaluate(broken);
  assert.equal(result.passed, false);
  assert.ok(
    result.checks.some(
      (check) => !check.passed && /Two runners compute/.test(check.title),
    ),
  );
});

test("fails when a dependency change does not change the key", () => {
  const broken = healthy().map((row) =>
    row.probe === "dependency"
      ? { ...row, key: `setup-java-${row.platform}-maven-aaa` }
      : row,
  );
  const result = evaluate(broken);
  assert.equal(result.passed, false);
});

// A version that computes no key at all would otherwise satisfy every sameness
// check by comparing empty with empty, and the report would read as a clean pass
// for an action that had stopped caching entirely.
test("treats a missing key as a failure rather than as equality", () => {
  const empty = healthy().map((row) => ({ ...row, key: "" }));
  const result = evaluate(empty);
  assert.equal(result.passed, false);
  assert.ok(
    result.checks.every((check) => check.expect !== "same" || !check.passed),
  );
  assert.match(
    result.checks.find((check) => !check.passed).detail,
    /no cache-primary-key/,
  );
});

test("reports what each failure costs", () => {
  const broken = healthy().map((row) =>
    row.probe === "unrelated" ? { ...row, key: "changed" } : row,
  );
  const rendered = markdown(
    {
      runId: "1",
      setupJavaRepository: "actions/setup-java",
      setupJavaRef: "main",
    },
    evaluate(broken),
  );
  assert.match(rendered, /checks failed/);
  assert.match(rendered, /## What each failure costs/);
});
