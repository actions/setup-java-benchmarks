import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapInterval,
  classify,
  createRandom,
  describeVerdict,
  differenceInterval,
  formatInterval,
  holmAdjust,
  hodgesLehmann,
  mean,
  median,
  medianAbsoluteDeviation,
  pairedInterval,
  pairedPermutationTest,
  pairsNeededForSignificance,
  quantile,
  significanceReachable,
  standardDeviation,
} from "./stats.mjs";

test("summarises central tendency and spread", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(standardDeviation([2, 2, 2]), 0);
  assert.equal(standardDeviation([1]), null);
  assert.equal(medianAbsoluteDeviation([5, 5, 5]), 0);
  assert.equal(mean([]), null);
  assert.equal(median([]), null);
});

test("resampling is deterministic across runs", () => {
  const values = [1.2, 1.4, 1.1, 1.9, 1.3, 1.5, 1.2, 1.8];
  const first = bootstrapInterval(values, median, { iterations: 500, seed: 7 });
  const second = bootstrapInterval(values, median, {
    iterations: 500,
    seed: 7,
  });
  assert.deepEqual(first, second);

  const random = createRandom(42);
  const draws = [random(), random(), random()];
  const replayed = createRandom(42);
  assert.deepEqual(draws, [replayed(), replayed(), replayed()]);
});

test("bootstrap interval brackets the point estimate", () => {
  const values = [2.0, 2.1, 2.2, 2.3, 2.4, 2.5];
  const interval = bootstrapInterval(values, median, {
    iterations: 2000,
    seed: 11,
  });
  assert.ok(interval.low <= interval.estimate);
  assert.ok(interval.high >= interval.estimate);
  assert.equal(interval.confidence, 0.95);
});

test("detects a real effect and rejects a null effect", () => {
  // A large, consistent within-runner improvement must be reported.
  const realEffect = Array.from(
    { length: 12 },
    (_, index) => -1 + index * 0.01,
  );
  const realInterval = pairedInterval(realEffect, {
    iterations: 2000,
    seed: 3,
  });
  assert.equal(classify(realInterval, { noiseFloor: 0.05 }), "improvement");
  assert.ok(
    pairedPermutationTest(realEffect, { iterations: 2000, seed: 3 }) < 0.01,
  );

  // Differences that merely alternate around zero must not be.
  const noEffect = [0.4, -0.3, 0.2, -0.5, 0.1, -0.2, 0.35, -0.4];
  const nullInterval = pairedInterval(noEffect, { iterations: 2000, seed: 3 });
  assert.equal(classify(nullInterval, { noiseFloor: 0.05 }), "inconclusive");
  assert.ok(
    pairedPermutationTest(noEffect, { iterations: 2000, seed: 3 }) > 0.1,
  );
});

test("suppresses effects smaller than the noise floor", () => {
  const tiny = Array.from({ length: 40 }, () => -0.02);
  const interval = pairedInterval(tiny, { iterations: 1000, seed: 5 });
  // The interval excludes zero because the samples are identical, but the
  // effect is far below what the harness can resolve.
  assert.equal(classify(interval, { noiseFloor: 0.25 }), "within-noise");
  assert.equal(classify(interval, { noiseFloor: 0.001 }), "improvement");
});

test("classifies direction and missing intervals", () => {
  assert.equal(classify({ low: 0.2, high: 0.8, estimate: 0.5 }), "regression");
  assert.equal(
    classify({ low: -0.8, high: -0.2, estimate: -0.5 }),
    "improvement",
  );
  assert.equal(
    classify({ low: 0.2, high: 0.8, estimate: 0.5 }, { lowerIsBetter: false }),
    "improvement",
  );
  assert.equal(classify(null), "unknown");
});

test("estimates a shift with Hodges-Lehmann", () => {
  assert.equal(hodgesLehmann([3, 4, 5], [1, 2, 3]), 2);
  assert.equal(hodgesLehmann([], [1]), null);
});

// Regression test built from two real back-to-back runs of the previous
// harness against an unchanged actions/setup-java@v4.8.0. Because the code was
// identical, the true effect is exactly zero, yet the old unpaired design
// separated the two samples cleanly. This test pins that failure so nobody
// reintroduces unpaired sampling: better statistics alone cannot rescue it,
// because the samples really do differ once between-runner drift is baked in.
test("unpaired sampling produces a false positive on identical code", () => {
  const runOne = [2, 1, 3, 1, 1, 2, 3, 2, 2, 2];
  const runTwo = [3, 4, 2, 4, 4, 3, 4, 3, 3, 1];
  const interval = differenceInterval(runTwo, runOne, median, {
    iterations: 4000,
    seed: 13,
  });
  // The interval excludes zero even though both samples measure the same code.
  assert.ok(interval.low > 0 || interval.high < 0);
  assert.equal(classify(interval, { noiseFloor: 0 }), "regression");

  // The only defence left for unpaired data is a noise floor calibrated from
  // observed run-to-run drift, which suppresses the spurious verdict.
  assert.equal(classify(interval, { noiseFloor: 1.5 }), "within-noise");
});

test("formatInterval labels the interval's own confidence level", () => {
  assert.equal(
    formatInterval(
      { estimate: -1.25, low: -2, high: -0.5, confidence: 0.95 },
      { digits: 2 },
    ),
    "-1.25s (95% CI -2.00 to -0.50)",
  );
  // A caller that widens the interval must not have it published as 95%.
  assert.equal(
    formatInterval(
      { estimate: -1.25, low: -3, high: 0.5, confidence: 0.99 },
      { digits: 2 },
    ),
    "-1.25s (99% CI -3.00 to 0.50)",
  );
  // Intervals built before `confidence` was carried still read as 95%.
  assert.equal(
    formatInterval({ estimate: 0, low: -1, high: 1 }),
    "0.000s (95% CI -1.000 to 1.000)",
  );
});

test("Holm adjustment controls a family of p-values", () => {
  assert.deepEqual(holmAdjust([0.01, 0.04, 0.2]), [0.03, 0.08, 0.2]);
  assert.deepEqual(holmAdjust([null, 0.01, 0.2]), [null, 0.02, 0.2]);
});

// A four-runner design cannot clear 0.05 no matter how large the effect is,
// because the sign-flip test only has sixteen assignments to draw on. Reporting
// that as "inconclusive" invites someone to read the number anyway.
test("calls a design underpowered when significance is unreachable", () => {
  assert.equal(significanceReachable(4), false);
  assert.equal(significanceReachable(5), true);
  assert.equal(pairsNeededForSignificance(), 5);

  const decisive = { estimate: -22, low: -28, high: -18 };
  assert.equal(
    classify(decisive, { pValue: 0.061, pairCount: 4 }),
    "underpowered",
  );
  assert.equal(
    classify(decisive, { pValue: 0.01, pairCount: 10 }),
    "improvement",
  );
});

test("explains what an underpowered run can and cannot show", () => {
  const described = describeVerdict("underpowered");
  assert.match(described, /at least 5/);
  assert.match(described, /may be real/);
});
