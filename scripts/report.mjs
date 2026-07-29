import {createHash} from 'node:crypto';
import {mkdir, writeFile, appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const API_VERSION = '2022-11-28';
const VERSIONS = ['v1', 'v2', 'v3', 'v4', 'v5.2', 'v5.6', 'main'];
const VERSION_IDS = new Map([
  ['v1', 'v1'],
  ['v2', 'v2'],
  ['v3', 'v3'],
  ['v4', 'v4'],
  ['v5.2', 'v52'],
  ['v5.6', 'v56'],
  ['main', 'main']
]);
const JOB_PATTERN =
  /^(v1|v2|v3|v4|v5\.2|v5\.6|main) \/ (cold|warm) \/ (zulu|temurin|microsoft) \/ (\d+)$/;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hashFilesSingle(value) {
  const contentHash = createHash('sha256').update(value).digest();
  return createHash('sha256').update(contentHash).digest('hex');
}

export function secondsBetween(start, end) {
  if (!start || !end) return null;
  return (Date.parse(end) - Date.parse(start)) / 1000;
}

export function median(values) {
  const sorted = values.filter(value => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function parseBenchmarkJob(name) {
  const match = name.match(JOB_PATTERN);
  if (!match) return null;
  return {
    version: match[1],
    phase: match[2],
    distribution: match[3],
    iteration: Number(match[4])
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

function summarize(rows, caches) {
  return VERSIONS.map(version => {
    const versionRows = rows.filter(row => row.version === version);
    const coldRows = versionRows.filter(row => row.phase === 'cold');
    const warmRows = versionRows.filter(row => row.phase === 'warm');
    const versionCaches = caches.filter(cache => cache.version === version);
    const caseTotals = new Map();
    for (const cache of versionCaches) {
      if (cache.sizeBytes === null) continue;
      const key = `${cache.distribution}-${cache.iteration}`;
      caseTotals.set(key, (caseTotals.get(key) ?? 0) + cache.sizeBytes);
    }
    return {
      version,
      coldSetupSeconds: median(coldRows.map(row => row.setupSeconds)),
      warmSetupSeconds: median(warmRows.map(row => row.setupSeconds)),
      coldBuildSeconds: median(coldRows.map(row => row.buildSeconds)),
      warmBuildSeconds: median(warmRows.map(row => row.buildSeconds)),
      postCacheSeconds: median(coldRows.map(row => row.postCacheSeconds)),
      jobSeconds: median(versionRows.map(row => row.jobSeconds)),
      estimatedBilledMinutes: versionRows.reduce(
        (total, row) => total + Math.ceil(row.jobSeconds / 60),
        0
      ),
      cacheMiBPerCase:
        caseTotals.size === 0
          ? null
          : median([...caseTotals.values()]) / 1024 / 1024
    };
  });
}

function markdown(metadata, rows, caches, summaries) {
  const lines = [
    '# setup-java benchmark',
    '',
    `Spring PetClinic \`${metadata.petclinicRef.slice(0, 12)}\`, Java ${metadata.javaVersion}, run ${metadata.runId}.`,
    '',
    '| Version | Cold setup (s) | Warm setup (s) | Cold build (s) | Warm build (s) | Cold post-cache (s) | Cache/case (MiB) | Estimated billed minutes |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];
  for (const summary of summaries) {
    lines.push(
      `| ${summary.version} | ${formatSeconds(summary.coldSetupSeconds)} | ${formatSeconds(summary.warmSetupSeconds)} | ${formatSeconds(summary.coldBuildSeconds)} | ${formatSeconds(summary.warmBuildSeconds)} | ${formatSeconds(summary.postCacheSeconds)} | ${summary.cacheMiBPerCase === null ? 'n/a' : summary.cacheMiBPerCase.toFixed(1)} | ${summary.estimatedBilledMinutes} |`
    );
  }
  lines.push(
    '',
    'Times and cache sizes are medians across distributions and iterations. Estimated billed minutes round each Linux job up to a whole minute; actual billing depends on the repository and runner plan.',
    '',
    '## Samples',
    '',
    '| Version | Cache | Distribution | Iteration | Setup (s) | Build (s) | Post-cache (s) | Job (s) | Conclusion |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |'
  );
  for (const row of rows) {
    lines.push(
      `| ${row.version} | ${row.phase} | ${row.distribution} | ${row.iteration} | ${formatSeconds(row.setupSeconds)} | ${formatSeconds(row.buildSeconds)} | ${formatSeconds(row.postCacheSeconds)} | ${formatSeconds(row.jobSeconds)} | ${row.conclusion} |`
    );
  }
  lines.push(
    '',
    '## Cache entries',
    '',
    '| Version | Distribution | Iteration | Cache | Size (MiB) |',
    '| --- | --- | ---: | --- | ---: |'
  );
  for (const cache of caches) {
    lines.push(
      `| ${cache.version} | ${cache.distribution} | ${cache.iteration} | ${cache.type} | ${formatMiB(cache.sizeBytes)} |`
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

  const [
    jobs,
    cacheEntries,
    wrapperResponse,
    pomResponse,
    mainCommit,
    v1Ref,
    v2Ref,
    v3Ref,
    v4Ref,
    v52Ref,
    v56Ref
  ] = await Promise.all([
      allPages(
        `/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`,
        'jobs',
        token
      ),
      allPages(`/repos/${owner}/${repo}/actions/caches`, 'actions_caches', token),
      api(
        `/repos/spring-projects/spring-petclinic/contents/.mvn/wrapper/maven-wrapper.properties?ref=${petclinicRef}`,
        token
      ),
      api(
        `/repos/spring-projects/spring-petclinic/contents/pom.xml?ref=${petclinicRef}`,
        token
      ),
      api('/repos/actions/setup-java/commits/main', token),
      api('/repos/actions/setup-java/git/ref/tags/v1.4.4', token),
      api('/repos/actions/setup-java/git/ref/tags/v2.5.1', token),
      api('/repos/actions/setup-java/git/ref/tags/v3.14.1', token),
      api('/repos/actions/setup-java/git/ref/tags/v4.8.0', token),
      api('/repos/actions/setup-java/git/ref/tags/v5.2.0', token),
      api('/repos/actions/setup-java/git/ref/tags/v5.6.0', token)
    ]);

  const rows = jobs
    .map(job => {
      const identity = parseBenchmarkJob(job.name);
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
        a.version.localeCompare(b.version) ||
        a.phase.localeCompare(b.phase) ||
        a.distribution.localeCompare(b.distribution) ||
        a.iteration - b.iteration
    );

  const wrapperOriginal = Buffer.from(wrapperResponse.content, 'base64').toString(
    'utf8'
  );
  const pomOriginal = Buffer.from(pomResponse.content, 'base64').toString('utf8');
  const coldCases = rows.filter(row => row.phase === 'cold');
  const caches = [];
  for (const row of coldCases) {
    const versionId = VERSION_IDS.get(row.version);
    const benchmarkId = `${versionId}-${row.distribution}-${row.iteration}-${runId}`;
    const expected =
      row.version === 'v1' || row.version === 'v2'
        ? []
        : row.version === 'v3'
        ? [
            {
              type: 'maven-dependencies',
              key: `setup-java-Linux-maven-${hashFilesSingle(
                `${pomOriginal}<!-- benchmark-id=${benchmarkId} -->\n`
              )}`
            }
          ]
        : [
            {
              type: 'maven-dependencies',
              key: `setup-java-Linux-x64-maven-${hashFilesSingle(
                `${benchmarkId}\n`
              )}`
            }
          ];
    if (row.version === 'v5.6' || row.version === 'main') {
      expected.push({
        type: 'maven-wrapper',
        key: `setup-java-Linux-x64-maven-wrapper-${hashFilesSingle(
          `${wrapperOriginal}# benchmark-id=${benchmarkId}\n`
        )}`
      });
    }
    for (const item of expected) {
      const entry = cacheEntries.find(cache => cache.key === item.key);
      caches.push({
        version: row.version,
        distribution: row.distribution,
        iteration: row.iteration,
        type: item.type,
        key: item.key,
        id: entry?.id ?? null,
        sizeBytes: entry?.size_in_bytes ?? null
      });
    }
  }

  const missingCaches = caches.filter(cache => cache.id === null);
  if (missingCaches.length > 0) {
    console.warn(`Could not find ${missingCaches.length} expected cache entries`);
  }

  const metadata = {
    repository: env.GITHUB_REPOSITORY,
    runId,
    runAttempt: Number(attempt),
    javaVersion: env.JAVA_VERSION,
    iterations: Number(env.ITERATIONS),
    petclinicRef,
    setupJavaV1Ref: v1Ref.object.sha,
    setupJavaV2Ref: v2Ref.object.sha,
    setupJavaV3Ref: v3Ref.object.sha,
    setupJavaV4Ref: v4Ref.object.sha,
    setupJavaV52Ref: v52Ref.object.sha,
    setupJavaV56Ref: v56Ref.object.sha,
    setupJavaMainRefAtReport: mainCommit.sha,
    generatedAt: new Date().toISOString()
  };
  const summaries = summarize(rows, caches);
  const report = markdown(metadata, rows, caches, summaries);

  await mkdir('results', {recursive: true});
  await writeFile(
    'results/results.json',
    `${JSON.stringify({metadata, summaries, rows, caches}, null, 2)}\n`
  );
  const csvHeaders = [
    'version',
    'phase',
    'distribution',
    'iteration',
    'setup_seconds',
    'build_seconds',
    'post_cache_seconds',
    'job_seconds',
    'conclusion'
  ];
  const csvRows = rows.map(row =>
    [
      row.version,
      row.phase,
      row.distribution,
      row.iteration,
      row.setupSeconds,
      row.buildSeconds,
      row.postCacheSeconds,
      row.jobSeconds,
      row.conclusion
    ]
      .map(csvValue)
      .join(',')
  );
  await writeFile(
    'results/results.csv',
    `${csvHeaders.join(',')}\n${csvRows.join('\n')}\n`
  );
  await writeFile('results/summary.md', report);
  await appendFile(env.GITHUB_STEP_SUMMARY, report);

  if (env.CLEANUP_CACHES === 'true') {
    const ids = [...new Set(caches.map(cache => cache.id).filter(Boolean))];
    for (const id of ids) {
      await api(`/repos/${owner}/${repo}/actions/caches/${id}`, token, {
        method: 'DELETE'
      });
    }
    console.log(`Deleted ${ids.length} benchmark cache entries after reporting`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
