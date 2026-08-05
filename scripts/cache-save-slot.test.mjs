import { strict as assert } from "node:assert";
import test from "node:test";

import { envKey, input } from "../.github/actions/cache-save-slot/index.js";

// The first live run of the local action failed every slot with "Input
// `arm-directory` is required" while the runner log showed the inputs being
// passed correctly. The runner uppercases an input name and replaces spaces with
// underscores but leaves hyphens alone, so the value was sitting in
// `INPUT_ARM-DIRECTORY` while the action was reading `INPUT_ARM_DIRECTORY`.
test("envKey keeps hyphens, matching the runner's own mangling", () => {
  assert.equal(envKey("arm-directory"), "INPUT_ARM-DIRECTORY");
  assert.equal(envKey("key"), "INPUT_KEY");
  assert.equal(envKey("results file"), "INPUT_RESULTS_FILE");
});

test("input reads hyphenated names from the runner environment", () => {
  const env = { "INPUT_ARM-DIRECTORY": "baseline" };
  assert.equal(input("arm-directory", env), "baseline");
});

test("input trims surrounding whitespace", () => {
  assert.equal(input("key", { INPUT_KEY: "  abc  " }), "abc");
});

test("input returns empty string for an absent optional value", () => {
  assert.equal(input("results-file", {}), "");
});

test("input rejects an absent or blank required value", () => {
  assert.throws(
    () => input("key", {}, { required: true }),
    /`key` is required/,
  );
  assert.throws(
    () => input("key", { INPUT_KEY: "   " }, { required: true }),
    /`key` is required/,
  );
});
