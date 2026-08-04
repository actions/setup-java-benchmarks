import {appendFile, mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

import {hashFilesSingle, secondsBetween} from './report.mjs';

const API_VERSION = '2022-11-28';
const JOB_PATTERN = /^(baseline|candidate) \/ (cold|warm)$/;
const JDK_CACHE_PREFIX = 'setup-java-jdk-v1-Linux-x64-';

export function parseJdkCacheJob(name) {
  const match = name.match(JOB_PATTERN);
  if (!match) return null;
  return {variant: match[1], phase: match[2]};
}

function formatSeconds(value) {
  return value === null ? 'n/a' : value.toFixed(1);
}

function formatMiB(value) {
  return value === null ? 'n/a' : (value / 1024 / 1024).toFixed(1);
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

function markdown(metadata, rows, caches) {
  const lines = [
    '# JDK cache benchmark',
    '',
    `Microsoft OpenJDK ${metadata.javaVersion}, Spring PetClinic \`${metadata.petclinicRef.slice(0, 12)}\`, run ${metadata.runId}.`,
    '',
    '| Variant | Cache state | Setup (s) | Build (s) | Post-cache (s) | Total job (s) |',
    '| --- | --- | ---: | ---: | ---: | ---: |'
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.variant} | ${row.phase} | ${formatSeconds(row.setupSeconds)} | ${formatSeconds(row.buildSeconds)} | ${formatSeconds(row.postCacheSeconds)} | ${formatSeconds(row.jobSeconds)} |`
    );
  }
  lines.push(
    '',
    '## Cache entries',
    '',
    '| Variant | Cache | Size (MiB) |',
    '| --- | --- | ---: |'
  );
  for (const cache of caches) {
    lines.push(
      `| ${cache.variant} | ${cache.type} | ${formatMiB(cache.sizeBytes)} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function main(env = process.env) {
  const [owner, repo] = env.GITHUB_REPOSITORY.split('/');
  const token = env.GH_TOKEN;
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  const petclinicRef = env.PETCLINIC_REF;
  if (!owner || !repo || !token || !runId || !attempt || !petclinicRef) {
    throw new Error('Missing required GitHub Actions environment variables');
  }

  const [jobs, cacheEntries, wrapperResponse] = await Promise.all([
    allPages(
      `/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`,
      'jobs',
      token
    ),
    allPages(`/repos/${owner}/${repo}/actions/caches`, 'actions_caches', token),
    api(
      `/repos/spring-projects/spring-petclinic/contents/.mvn/wrapper/maven-wrapper.properties?ref=${petclinicRef}`,
      token
    )
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
        postCacheSeconds: stepDuration(job, step =>
          step.name.startsWith('Post Setup Java')
        ),
        jobSeconds: secondsBetween(job.started_at, job.completed_at)
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.variant.localeCompare(b.variant) || a.phase.localeCompare(b.phase)
    );

  const wrapperOriginal = Buffer.from(wrapperResponse.content, 'base64').toString(
    'utf8'
  );
  const caches = [];
  for (const variant of ['baseline', 'candidate']) {
    const benchmarkId = `jdk-${variant}-${runId}`;
    for (const expected of [
      {
        type: 'maven-dependencies',
        key: `setup-java-Linux-x64-maven-${hashFilesSingle(
          `${benchmarkId}\n`
        )}`
      },
      {
        type: 'maven-wrapper',
        key: `setup-java-Linux-x64-maven-wrapper-${hashFilesSingle(
          `${wrapperOriginal}# benchmark-id=${benchmarkId}\n`
        )}`
      }
    ]) {
      const entry = cacheEntries.find(cache => cache.key === expected.key);
      caches.push({
        variant,
        type: expected.type,
        key: expected.key,
        id: entry?.id ?? null,
        sizeBytes: entry?.size_in_bytes ?? null
      });
    }
  }

  const jdkEntries = cacheEntries.filter(cache =>
    cache.key.startsWith(JDK_CACHE_PREFIX)
  );
  if (jdkEntries.length !== 1) {
    throw new Error(
      `Expected exactly one JDK cache entry, found ${jdkEntries.length}`
    );
  }
  caches.push({
    variant: 'candidate',
    type: 'jdk',
    key: jdkEntries[0].key,
    id: jdkEntries[0].id,
    sizeBytes: jdkEntries[0].size_in_bytes
  });

  const missingCaches = caches.filter(cache => cache.id === null);
  if (missingCaches.length > 0) {
    throw new Error(`Could not find ${missingCaches.length} expected caches`);
  }

  const metadata = {
    repository: env.GITHUB_REPOSITORY,
    runId,
    runAttempt: Number(attempt),
    javaVersion: env.JAVA_VERSION,
    petclinicRef,
    baselineRef: env.BASELINE_REF,
    candidateRef: env.CANDIDATE_REF,
    generatedAt: new Date().toISOString()
  };
  const report = markdown(metadata, rows, caches);
  await mkdir('jdk-cache-results', {recursive: true});
  await writeFile(
    'jdk-cache-results/results.json',
    `${JSON.stringify({metadata, rows, caches}, null, 2)}\n`
  );
  await writeFile(
    'jdk-cache-results/results.csv',
    `variant,phase,setup_seconds,build_seconds,post_cache_seconds,job_seconds,conclusion\n${rows
      .map(row =>
        [
          row.variant,
          row.phase,
          row.setupSeconds,
          row.buildSeconds,
          row.postCacheSeconds,
          row.jobSeconds,
          row.conclusion
        ]
          .map(csvValue)
          .join(',')
      )
      .join('\n')}\n`
  );
  await writeFile('jdk-cache-results/summary.md', report);
  await appendFile(env.GITHUB_STEP_SUMMARY, report);

  if (env.CLEANUP_CACHES === 'true') {
    for (const id of new Set(caches.map(cache => cache.id))) {
      await api(`/repos/${owner}/${repo}/actions/caches/${id}`, token, {
        method: 'DELETE'
      });
    }
    console.log(`Deleted ${caches.length} JDK benchmark cache entries`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
