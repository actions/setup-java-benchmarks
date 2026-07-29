import assert from 'node:assert/strict';
import test from 'node:test';

import {
  median,
  parseBenchmarkJob,
  secondsBetween,
  sha256
} from './report.mjs';

test('hashes benchmark cache markers', () => {
  assert.equal(
    sha256('benchmark\n'),
    '8f8dbecfd77ab2386b49d723c6b2474f2c22c246805fa0f677bbaf6e4f7bbbfe'
  );
});

test('calculates medians', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([null]), null);
});

test('calculates step duration', () => {
  assert.equal(
    secondsBetween('2026-01-01T00:00:01Z', '2026-01-01T00:00:04.500Z'),
    3.5
  );
});

test('parses benchmark job names', () => {
  assert.deepEqual(parseBenchmarkJob('v5.6 / cold / temurin / 3'), {
    version: 'v5.6',
    phase: 'cold',
    distribution: 'temurin',
    iteration: 3
  });
  assert.equal(parseBenchmarkJob('Report'), null);
});
