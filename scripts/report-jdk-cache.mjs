import {appendFile, mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

import {hashFilesSingle, median, secondsBetween} from './report.mjs';

const API_VERSION = '2022-11-28';
const ARMS = ['baseline', 'treatment'];
const JOB_PATTERN = /^(baseline|treatment) \/ (seed|warm)(?: \/ (\d+))?$/;
const JDK_CACHE_PREFIX = 'setup-java-jdk-';

export function parseJdkCacheJob(name) {
  const match = name.match(JOB_PATTERN);
  if (!match) return null;
  const [, arm, phase, sampleText] = match;
  if ((phase === 'seed' && sampleText) || (phase === 'warm' && !sampleText)) {
    return null;
  }
  return {
    arm,
    phase,
    sample: sampleText ? Number(sampleText) : null
  };
}

export function newestJdkCache(cacheEntries) {
  return (
    cacheEntries
      .filter(cache => cache.key.startsWith(JDK_CACHE_PREFIX))
      .sort(
        (a, b) =>
          Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0)
      )[0] ?? null
  );
}

export function expectedArmCacheKeys(arm, runId, wrapperOriginal) {
  const benchmarkId = `jdk-cache-${arm}-${runId}`;
  return {
    dependencies: `setup-java-Linux-x64-maven-${hashFilesSingle(
      `${benchmarkId}\n`
    )}`,
    wrapper: `setup-java-Linux-x64-maven-wrapper-${hashFilesSingle(
      `${wrapperOriginal}# jdk-cache-benchmark=${benchmarkId}\n`
    )}`
  };
}

export function summarizeJdkArm(rows, arm) {
  const armRows = rows.filter(row => row.arm === arm);
  const warmRows = armRows.filter(row => row.phase === 'warm');
  const seed = armRows.find(row => row.phase === 'seed') ?? null;
  return {
    arm,
    samples: warmRows.length,
    warmSetupSeconds: median(warmRows.map(row => row.setupSeconds)),
    warmBuildSeconds: median(warmRows.map(row => row.buildSeconds)),
    warmPostSeconds: median(warmRows.map(row => row.postSeconds)),
    warmJobSeconds: median(warmRows.map(row => row.jobSeconds)),
    coldSetupSeconds: seed?.setupSeconds ?? null,
    coldPostSeconds: seed?.postSeconds ?? null,
    estimatedBilledMinutes: warmRows.reduce(
      (total, row) =>
        total +
        (row.jobSeconds === null ? 0 : Math.ceil(row.jobSeconds / 60)),
      0
    )
  };
}

function formatSeconds(value) {
  return value === null ? 'n/a' : value.toFixed(1);
}

function formatMiB(bytes) {
  return bytes === null ? 'n/a' : (bytes / 1024 / 1024).toFixed(1);
}

function csvValue(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

async function api(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...options.headers
    }
  });
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function allPages(path, field, token) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await api(
      `${path}${separator}per_page=100&page=${page}`,
      token
    );
    values.push(...response[field]);
    if (response[field].length < 100) return values;
  }
}

function stepDuration(job, predicate) {
  const step = job.steps.find(predicate);
  return step ? secondsBetween(step.started_at, step.completed_at) : null;
}

function buildCaches(cacheEntries, runId, wrapperOriginal) {
  const caches = [];
  for (const arm of ARMS) {
    const expected = expectedArmCacheKeys(arm, runId, wrapperOriginal);
    for (const [type, key] of Object.entries(expected)) {
      const entry = cacheEntries.find(cache => cache.key === key);
      caches.push({
        arm,
        type,
        key,
        id: entry?.id ?? null,
        sizeBytes: entry?.size_in_bytes ?? null
      });
    }
  }

  const jdkEntry = newestJdkCache(cacheEntries);
  caches.push({
    arm: 'treatment',
    type: 'jdk',
    key: jdkEntry?.key ?? null,
    id: jdkEntry?.id ?? null,
    sizeBytes: jdkEntry?.size_in_bytes ?? null
  });
  return caches;
}

function markdown(metadata, rows, summaries, caches) {
  const baseline = summaries.find(summary => summary.arm === 'baseline');
  const treatment = summaries.find(summary => summary.arm === 'treatment');
  const jdkCache = caches.find(cache => cache.type === 'jdk');
  const delta =
    baseline.warmSetupSeconds === null || treatment.warmSetupSeconds === null
      ? null
      : treatment.warmSetupSeconds - baseline.warmSetupSeconds;
  const lines = [
    '# JDK cache benchmark',
    '',
    `${metadata.distribution} Java ${metadata.javaVersion}, ${metadata.samples} warm samples per arm, run ${metadata.runId}.`,
    '',
    '## Headline',
    '',
    `Baseline warm setup: **${formatSeconds(baseline.warmSetupSeconds)}s**; treatment warm setup: **${formatSeconds(treatment.warmSetupSeconds)}s**; treatment delta: **${formatSeconds(delta)}s**. JDK cache storage: **${formatMiB(jdkCache.sizeBytes)} MiB**.`,
    ''
  ];

  if (jdkCache.id === null) {
    lines.push(
      '> [!WARNING]',
      '> No `setup-java-jdk-` cache entry exists after the treatment seed. The runner tool cache may have been hit or JDK caching was disabled, so this run does not measure a JDK cache restore.',
      ''
    );
  }

  lines.push(
    '| Arm | Warm samples | Median setup (s) | Median build (s) | Median post-step (s) | Median job (s) | Cold seed setup (s) | Cold seed post-save (s) | Estimated billed minutes |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  );
  for (const summary of summaries) {
    lines.push(
      `| ${summary.arm} | ${summary.samples} | ${formatSeconds(summary.warmSetupSeconds)} | ${formatSeconds(summary.warmBuildSeconds)} | ${formatSeconds(summary.warmPostSeconds)} | ${formatSeconds(summary.warmJobSeconds)} | ${formatSeconds(summary.coldSetupSeconds)} | ${formatSeconds(summary.coldPostSeconds)} | ${summary.estimatedBilledMinutes} |`
    );
  }

  lines.push(
    '',
    'The billed-minute estimate covers only warm measurement jobs, rounding each Ubuntu job up to a whole minute. It excludes seeds because they are one-time setup and the treatment seed pays the JDK save, which would distort the steady-state comparison. It also excludes the shared prepare and report jobs.',
    '',
    '## Cache entries',
    '',
    '| Arm | Cache | Size (MiB) | Key |',
    '| --- | --- | ---: | --- |'
  );
  for (const cache of caches) {
    lines.push(
      `| ${cache.arm} | ${cache.type} | ${formatMiB(cache.sizeBytes)} | ${cache.key === null ? 'not found' : `\`${cache.key}\``} |`
    );
  }

  lines.push(
    '',
    '## Samples',
    '',
    '| Arm | Phase | Sample | Setup (s) | Build (s) | Post-step (s) | Job (s) | Conclusion |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |'
  );
  for (const row of rows) {
    lines.push(
      `| ${row.arm} | ${row.phase} | ${row.sample ?? '-'} | ${formatSeconds(row.setupSeconds)} | ${formatSeconds(row.buildSeconds)} | ${formatSeconds(row.postSeconds)} | ${formatSeconds(row.jobSeconds)} | ${row.conclusion} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function main(env = process.env) {
  const [owner, repo] = env.GITHUB_REPOSITORY.split('/');
  const token = env.GH_TOKEN;
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  const samples = Number(env.SAMPLES);
  if (
    !owner ||
    !repo ||
    !token ||
    !runId ||
    !attempt ||
    !samples ||
    !env.PETCLINIC_REF ||
    !env.DISTRIBUTION ||
    !env.JAVA_VERSION
  ) {
    throw new Error('Missing required GitHub Actions environment variables');
  }

  const [jobs, cacheEntries, wrapperResponse, mainCommit] = await Promise.all([
    allPages(
      `/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`,
      'jobs',
      token
    ),
    allPages(`/repos/${owner}/${repo}/actions/caches`, 'actions_caches', token),
    api(
      `/repos/spring-projects/spring-petclinic/contents/.mvn/wrapper/maven-wrapper.properties?ref=${env.PETCLINIC_REF}`,
      token
    ),
    api('/repos/actions/setup-java/commits/main', token)
  ]);

  const rows = jobs
    .map(job => {
      const identity = parseJdkCacheJob(job.name);
      if (!identity) return null;
      return {
        ...identity,
        conclusion: job.conclusion,
        setupSeconds: stepDuration(job, step =>
          step.name.startsWith('Setup Java')
        ),
        buildSeconds: stepDuration(job, step => step.name === 'Build PetClinic'),
        postSeconds: stepDuration(job, step =>
          step.name.startsWith('Post Setup Java')
        ),
        jobSeconds: secondsBetween(job.started_at, job.completed_at)
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.arm.localeCompare(b.arm) ||
        a.phase.localeCompare(b.phase) ||
        (a.sample ?? 0) - (b.sample ?? 0)
    );

  const wrapperOriginal = Buffer.from(wrapperResponse.content, 'base64').toString(
    'utf8'
  );
  const caches = buildCaches(cacheEntries, runId, wrapperOriginal);
  const missingCaches = caches.filter(cache => cache.id === null);
  if (missingCaches.length > 0) {
    console.warn(`Could not find ${missingCaches.length} expected cache entries`);
  }

  const metadata = {
    repository: env.GITHUB_REPOSITORY,
    runId,
    runAttempt: Number(attempt),
    samples,
    distribution: env.DISTRIBUTION,
    javaVersion: env.JAVA_VERSION,
    petclinicRef: env.PETCLINIC_REF,
    setupJavaMainRefAtReport: mainCommit.sha,
    generatedAt: new Date().toISOString()
  };
  const summaries = ARMS.map(arm => summarizeJdkArm(rows, arm));
  const report = markdown(metadata, rows, summaries, caches);

  await mkdir('jdk-cache-results', {recursive: true});
  await writeFile(
    'jdk-cache-results/results.json',
    `${JSON.stringify({metadata, summaries, rows, caches}, null, 2)}\n`
  );
  const csvHeaders = [
    'arm',
    'phase',
    'sample',
    'setup_seconds',
    'build_seconds',
    'post_seconds',
    'job_seconds',
    'conclusion'
  ];
  const csvRows = rows.map(row =>
    [
      row.arm,
      row.phase,
      row.sample,
      row.setupSeconds,
      row.buildSeconds,
      row.postSeconds,
      row.jobSeconds,
      row.conclusion
    ]
      .map(csvValue)
      .join(',')
  );
  await writeFile(
    'jdk-cache-results/results.csv',
    `${csvHeaders.join(',')}\n${csvRows.join('\n')}\n`
  );
  await writeFile('jdk-cache-results/summary.md', report);
  await appendFile(env.GITHUB_STEP_SUMMARY, report);

  if (env.CLEANUP_CACHES === 'true') {
    const benchmarkIds = caches.map(cache => cache.id).filter(Boolean);
    const jdkIds = cacheEntries
      .filter(cache => cache.key.startsWith(JDK_CACHE_PREFIX))
      .map(cache => cache.id);
    const ids = [...new Set([...benchmarkIds, ...jdkIds])];
    for (const id of ids) {
      await api(`/repos/${owner}/${repo}/actions/caches/${id}`, token, {
        method: 'DELETE'
      });
    }
    console.log(`Deleted ${ids.length} JDK benchmark cache entries`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
