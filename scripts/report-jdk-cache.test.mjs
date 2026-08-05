import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedArmCacheKeys,
  newestJdkCache,
  parseJdkCacheJob,
  summarizeJdkArm
} from './report-jdk-cache.mjs';

test('parses JDK cache benchmark job names', () => {
  assert.deepEqual(parseJdkCacheJob('baseline / seed'), {
    arm: 'baseline',
    phase: 'seed',
    sample: null
  });
  assert.deepEqual(parseJdkCacheJob('treatment / warm / 10'), {
    arm: 'treatment',
    phase: 'warm',
    sample: 10
  });
  assert.equal(parseJdkCacheJob('baseline / warm'), null);
  assert.equal(parseJdkCacheJob('Report'), null);
});

test('selects the newest JDK cache entry', () => {
  const newest = newestJdkCache([
    {
      key: 'setup-java-jdk-v1-Linux-x64-old',
      created_at: '2026-01-01T00:00:00Z'
    },
    {key: 'setup-java-Linux-x64-maven-not-a-jdk'},
    {
      key: 'setup-java-jdk-v1-Linux-x64-new',
      created_at: '2026-01-02T00:00:00Z'
    }
  ]);
  assert.equal(newest.key, 'setup-java-jdk-v1-Linux-x64-new');
  assert.equal(newestJdkCache([{key: 'setup-java-Linux-maven-key'}]), null);
});

test('derives distinct dependency and wrapper cache keys per arm', () => {
  const baseline = expectedArmCacheKeys('baseline', '42', 'wrapper=true\n');
  const treatment = expectedArmCacheKeys('treatment', '42', 'wrapper=true\n');
  assert.match(baseline.dependencies, /^setup-java-Linux-x64-maven-/);
  assert.match(baseline.wrapper, /^setup-java-Linux-x64-maven-wrapper-/);
  assert.notEqual(baseline.dependencies, treatment.dependencies);
  assert.notEqual(baseline.wrapper, treatment.wrapper);
});

test('summarizes seed and warm measurements for an arm', () => {
  const summary = summarizeJdkArm(
    [
      {
        arm: 'treatment',
        phase: 'seed',
        setupSeconds: 7,
        buildSeconds: 20,
        postSeconds: 8,
        jobSeconds: 61
      },
      {
        arm: 'treatment',
        phase: 'warm',
        setupSeconds: 4,
        buildSeconds: 10,
        postSeconds: 0.4,
        jobSeconds: 30
      },
      {
        arm: 'treatment',
        phase: 'warm',
        setupSeconds: 2,
        buildSeconds: 12,
        postSeconds: 0.2,
        jobSeconds: 40
      }
    ],
    'treatment'
  );
  assert.deepEqual(summary, {
    arm: 'treatment',
    samples: 2,
    warmSetupSeconds: 3,
    warmBuildSeconds: 11,
    warmPostSeconds: 0.30000000000000004,
    warmJobSeconds: 35,
    coldSetupSeconds: 7,
    coldPostSeconds: 8,
    estimatedBilledMinutes: 4
  });
});
