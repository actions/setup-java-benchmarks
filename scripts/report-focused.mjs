import {appendFile, mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

import {hashFilesSingle, median, secondsBetween} from './report.mjs';

const API_VERSION = '2022-11-28';
const JOB_PATTERN = /^(v5\.6|main) \/ warm \/ (\d+)$/;

export function parseFocusedJob(name) {
  const match = name.match(JOB_PATTERN);
  if (!match) return null;
  return {version: match[1], sample: Number(match[2])};
}

function quantile(values, percentile) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return (
    sorted[lower] +
    (sorted[upper] - sorted[lower]) * (position - lower)
  );
}

function csvValue(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
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

function summarize(rows, version) {
  const values = rows
    .filter(row => row.version === version)
    .map(row => row.setupSeconds);
  return {
    version,
    samples: values.length,
    minimumSeconds: Math.min(...values),
    medianSeconds: median(values),
    p95Seconds: quantile(values, 0.95),
    maximumSeconds: Math.max(...values)
  };
}

function markdown(metadata, rows, summaries, caches) {
  const lines = [
    '# Focused cache restore benchmark',
    '',
    `Temurin ${metadata.javaVersion}, ${metadata.samples} warm samples per version, run ${metadata.runId}.`,
    '',
    '| Version | Samples | Min (s) | Median (s) | p95 (s) | Max (s) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |'
  ];
  for (const summary of summaries) {
    lines.push(
      `| ${summary.version} | ${summary.samples} | ${summary.minimumSeconds.toFixed(1)} | ${summary.medianSeconds.toFixed(1)} | ${summary.p95Seconds.toFixed(1)} | ${summary.maximumSeconds.toFixed(1)} |`
    );
  }
  const deltas = [];
  for (let sample = 1; sample <= metadata.samples; sample += 1) {
    const v56 = rows.find(
      row => row.version === 'v5.6' && row.sample === sample
    );
    const main = rows.find(
      row => row.version === 'main' && row.sample === sample
    );
    if (v56 && main) deltas.push(main.setupSeconds - v56.setupSeconds);
  }
  lines.push(
    '',
    `Paired median delta (main - v5.6): **${median(deltas).toFixed(1)}s**. Negative means main was faster.`,
    '',
    '## Samples',
    '',
    '| Sample | v5.6 (s) | main (s) | Delta (s) |',
    '| ---: | ---: | ---: | ---: |'
  );
  for (let sample = 1; sample <= metadata.samples; sample += 1) {
    const v56 = rows.find(
      row => row.version === 'v5.6' && row.sample === sample
    );
    const main = rows.find(
      row => row.version === 'main' && row.sample === sample
    );
    if (v56 && main) {
      lines.push(
        `| ${sample} | ${v56.setupSeconds.toFixed(1)} | ${main.setupSeconds.toFixed(1)} | ${(main.setupSeconds - v56.setupSeconds).toFixed(1)} |`
      );
    }
  }
  lines.push(
    '',
    '## Cache fixtures',
    '',
    '| Version | Cache | Size (MiB) |',
    '| --- | --- | ---: |'
  );
  for (const cache of caches) {
    lines.push(
      `| ${cache.version} | ${cache.type} | ${(cache.sizeBytes / 1024 / 1024).toFixed(1)} |`
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
  const javaVersion = env.JAVA_VERSION;
  if (!owner || !repo || !token || !runId || !attempt || !samples) {
    throw new Error('Missing required GitHub Actions environment variables');
  }

  const [jobs, cacheEntries, mainCommit, v56Ref] = await Promise.all([
    allPages(
      `/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`,
      'jobs',
      token
    ),
    allPages(`/repos/${owner}/${repo}/actions/caches`, 'actions_caches', token),
    api('/repos/actions/setup-java/commits/main', token),
    api('/repos/actions/setup-java/git/ref/tags/v5.6.0', token)
  ]);

  const rows = jobs
    .map(job => {
      const identity = parseFocusedJob(job.name);
      if (!identity) return null;
      const step = job.steps.find(item =>
        item.name.startsWith('Setup Java')
      );
      return {
        ...identity,
        conclusion: job.conclusion,
        setupSeconds: secondsBetween(step.started_at, step.completed_at)
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.sample - b.sample || a.version.localeCompare(b.version)
    );

  const caches = [];
  for (const [version, versionId] of [
    ['v5.6', 'v56'],
    ['main', 'main']
  ]) {
    const benchmarkId = `focused-${versionId}-${runId}`;
    const expected = [
      {
        type: 'maven-dependencies',
        key: `setup-java-Linux-x64-maven-${hashFilesSingle(
          `${benchmarkId}\n`
        )}`
      },
      {
        type: 'maven-wrapper',
        key: `setup-java-Linux-x64-maven-wrapper-${hashFilesSingle(
          `wrapperVersion=focused\n# benchmark-id=${benchmarkId}\n`
        )}`
      }
    ];
    for (const item of expected) {
      const entry = cacheEntries.find(cache => cache.key === item.key);
      if (!entry) throw new Error(`Expected cache not found: ${item.key}`);
      caches.push({
        version,
        type: item.type,
        id: entry.id,
        key: item.key,
        sizeBytes: entry.size_in_bytes
      });
    }
  }

  const metadata = {
    repository: env.GITHUB_REPOSITORY,
    runId,
    runAttempt: Number(attempt),
    samples,
    javaVersion,
    setupJavaV56Ref: v56Ref.object.sha,
    setupJavaMainRefAtReport: mainCommit.sha,
    generatedAt: new Date().toISOString()
  };
  const summaries = ['v5.6', 'main'].map(version =>
    summarize(rows, version)
  );
  const report = markdown(metadata, rows, summaries, caches);

  await mkdir('focused-results', {recursive: true});
  await writeFile(
    'focused-results/results.json',
    `${JSON.stringify({metadata, summaries, rows, caches}, null, 2)}\n`
  );
  await writeFile(
    'focused-results/results.csv',
    `version,sample,setup_seconds,conclusion\n${rows
      .map(row =>
        [row.version, row.sample, row.setupSeconds, row.conclusion]
          .map(csvValue)
          .join(',')
      )
      .join('\n')}\n`
  );
  await writeFile('focused-results/summary.md', report);
  await appendFile(env.GITHUB_STEP_SUMMARY, report);

  if (env.CLEANUP_CACHES === 'true') {
    for (const cache of caches) {
      await api(`/repos/${owner}/${repo}/actions/caches/${cache.id}`, token, {
        method: 'DELETE'
      });
    }
    console.log(`Deleted ${caches.length} focused benchmark caches`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
