import assert from "node:assert/strict";
import test from "node:test";

import { requireEnv } from "./paired.mjs";

test("requireEnv names every missing variable", () => {
  assert.doesNotThrow(() => requireEnv({ A: "1", B: "2" }, ["A", "B"]));
  // An empty string is as unusable in a report as an absent variable.
  assert.throws(
    () => requireEnv({ A: "1", B: "" }, ["A", "B", "C"]),
    /Missing required environment variables: B, C/,
  );
});
