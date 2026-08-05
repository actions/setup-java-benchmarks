import assert from "node:assert/strict";
import test from "node:test";

import { analyze, markdown } from "./report-cache-value.mjs";
import { parseSamples } from "./paired.mjs";

// Slot order in the workflow is cached, uncached, uncached, cached.
function sample(runner, cached, uncached) {
  return [
    `"${runner}","cached","1","${cached}"`,
    `"${runner}","uncached","2","${uncached}"`,
    `"${runner}","uncached","3","${uncached}"`,
    `"${runner}","cached","4","${cached}"`,
  ].join("\n");
}

const rows = parseSamples(
  [1, 2, 3, 4, 5, 6]
    .map((runner) => sample(runner, 8000 + runner * 500, 46000 + runner * 3000))
    .join("\n"),
);

test("reports the cache as an improvement, not a regression", () => {
  const analysis = analyze(rows);
  assert.ok(
    analysis.interval.estimate < 0,
    "cached minus uncached must be negative when the cache saves time",
  );
  assert.equal(analysis.verdict, "improvement");
});

test("quotes the saving as a ratio as well as a difference", () => {
  const analysis = analyze(rows);
  const rendered = markdown(
    {
      runId: "1",
      javaVersion: "17",
      setupJavaRepository: "actions/setup-java",
      setupJavaRef: "main",
    },
    analysis,
    [],
  );
  // 56.5s uncached against 9.75s cached.
  assert.match(rendered, /5\.8x faster/);
  assert.match(rendered, /Maven cache value/);
});

// The failure this benchmark must never hide is a silent cache miss: both arms
// would then do the same download and the report would state, with a tight
// interval, that the cache is worth nothing. The workflow guards this with
// setup-java's cache-hit output, and the analysis must not paper over it either.
test("does not claim a saving when both arms did the same work", () => {
  const identical = parseSamples(
    [1, 2, 3, 4, 5, 6]
      .map((runner) =>
        sample(runner, 46000 + runner * 3000, 46000 + runner * 3000),
      )
      .join("\n"),
  );
  const analysis = analyze(identical);
  assert.ok(["within-noise", "inconclusive"].includes(analysis.verdict));
});
