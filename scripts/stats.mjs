// Statistical helpers shared by the benchmark reports.
//
// Benchmark arms run on ephemeral hosted runners, so every measurement carries
// substantial between-runner noise. Point estimates alone cannot tell a real
// improvement from that noise, so every comparison here is reported with an
// interval and an explicit verdict.

const BOOTSTRAP_ITERATIONS = 10000;
const DEFAULT_CONFIDENCE = 0.95;

// Deterministic PRNG so a given set of samples always produces the same
// interval. Reports are compared across runs and must not wobble because the
// resampler drew different numbers.
export function createRandom(seed = 0x9e3779b9) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function median(values) {
  return quantile(values, 0.5);
}

export function quantile(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function standardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance =
    values.reduce((total, value) => total + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

// Median absolute deviation, scaled to be comparable with a standard deviation
// for normally distributed data. Robust to the occasional runner that stalls.
export function medianAbsoluteDeviation(values) {
  if (values.length === 0) return null;
  const center = median(values);
  return 1.4826 * median(values.map(value => Math.abs(value - center)));
}

function resample(values, random) {
  const drawn = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    drawn[index] = values[Math.floor(random() * values.length)];
  }
  return drawn;
}

// Percentile bootstrap interval for an arbitrary statistic of one sample.
export function bootstrapInterval(values, statistic = median, options = {}) {
  const {
    iterations = BOOTSTRAP_ITERATIONS,
    confidence = DEFAULT_CONFIDENCE,
    seed
  } = options;
  if (values.length === 0) return null;
  const random = createRandom(seed);
  const estimates = new Array(iterations);
  for (let index = 0; index < iterations; index += 1) {
    estimates[index] = statistic(resample(values, random));
  }
  const alpha = (1 - confidence) / 2;
  return {
    estimate: statistic(values),
    low: quantile(estimates, alpha),
    high: quantile(estimates, 1 - alpha),
    confidence
  };
}

// Bootstrap interval for the difference between two independent samples.
export function differenceInterval(
  treatment,
  baseline,
  statistic = median,
  options = {}
) {
  const {
    iterations = BOOTSTRAP_ITERATIONS,
    confidence = DEFAULT_CONFIDENCE,
    seed
  } = options;
  if (treatment.length === 0 || baseline.length === 0) return null;
  const random = createRandom(seed);
  const estimates = new Array(iterations);
  for (let index = 0; index < iterations; index += 1) {
    estimates[index] =
      statistic(resample(treatment, random)) -
      statistic(resample(baseline, random));
  }
  const alpha = (1 - confidence) / 2;
  return {
    estimate: statistic(treatment) - statistic(baseline),
    low: quantile(estimates, alpha),
    high: quantile(estimates, 1 - alpha),
    confidence
  };
}

// Bootstrap interval for the mean of within-runner paired differences. This is
// the estimator to prefer whenever both arms were measured on the same runner,
// because it cancels the between-runner variance that dominates hosted CI.
export function pairedInterval(differences, options = {}) {
  const {
    iterations = BOOTSTRAP_ITERATIONS,
    confidence = DEFAULT_CONFIDENCE,
    seed
  } = options;
  if (differences.length === 0) return null;
  const random = createRandom(seed);
  const estimates = new Array(iterations);
  for (let index = 0; index < iterations; index += 1) {
    estimates[index] = mean(resample(differences, random));
  }
  const alpha = (1 - confidence) / 2;
  return {
    estimate: mean(differences),
    low: quantile(estimates, alpha),
    high: quantile(estimates, 1 - alpha),
    confidence
  };
}

// Two-sided permutation test on the mean of paired differences. Under the null
// hypothesis the sign of each pair is arbitrary, so we resample signs.
export function pairedPermutationTest(differences, options = {}) {
  const {iterations = BOOTSTRAP_ITERATIONS, seed} = options;
  if (differences.length === 0) return null;
  const random = createRandom(seed);
  const observed = Math.abs(mean(differences));
  let atLeastAsExtreme = 0;
  for (let index = 0; index < iterations; index += 1) {
    const flipped = differences.map(value => (random() < 0.5 ? -value : value));
    if (Math.abs(mean(flipped)) >= observed) atLeastAsExtreme += 1;
  }
  // Add-one correction keeps the p-value strictly positive.
  return (atLeastAsExtreme + 1) / (iterations + 1);
}

// Hodges-Lehmann shift estimate: the median of all pairwise differences. More
// robust than a difference of medians when samples are small and quantized.
export function hodgesLehmann(treatment, baseline) {
  if (treatment.length === 0 || baseline.length === 0) return null;
  const differences = [];
  for (const treatmentValue of treatment) {
    for (const baselineValue of baseline) {
      differences.push(treatmentValue - baselineValue);
    }
  }
  return median(differences);
}

// Turn an interval into a decision. An interval that straddles zero means the
// benchmark did not resolve the effect, and an effect smaller than the harness
// noise floor is not trustworthy even when the interval excludes zero.
export function classify(interval, options = {}) {
  const {noiseFloor = 0, lowerIsBetter = true} = options;
  if (!interval) return 'unknown';
  const {low, high, estimate} = interval;
  if (low <= 0 && high >= 0) return 'inconclusive';
  if (Math.abs(estimate) < noiseFloor) return 'within-noise';
  const improved = lowerIsBetter ? estimate < 0 : estimate > 0;
  return improved ? 'improvement' : 'regression';
}

export function formatInterval(interval, {digits = 1, unit = 's'} = {}) {
  if (!interval) return 'n/a';
  const {estimate, low, high} = interval;
  return `${estimate.toFixed(digits)}${unit} (95% CI ${low.toFixed(digits)} to ${high.toFixed(digits)})`;
}

export function describeVerdict(verdict) {
  switch (verdict) {
    case 'improvement':
      return 'Faster — the interval excludes zero and clears the noise floor.';
    case 'regression':
      return 'Slower — the interval excludes zero and clears the noise floor.';
    case 'within-noise':
      return 'No usable signal — the effect is smaller than the harness noise floor.';
    case 'inconclusive':
      return 'Inconclusive — the confidence interval includes zero; collect more samples.';
    default:
      return 'Unknown.';
  }
}
