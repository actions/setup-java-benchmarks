#!/usr/bin/env bash

set -euo pipefail

command=${1:?command is required}
fixture_dir="$HOME/.m2/repository/cache-save-fixture"

# A Maven cache save is not just bytes on the wire. The archive step walks a deep
# repository tree and compresses thousands of already-compressed jars plus their
# small metadata sidecars, so a flat file would erase the traversal and path
# enumeration work that changes in setup-java's cache client can affect.
case "$command" in
  prepare-fixture)
    fixture_mib=${2:?fixture size in MiB is required}
    rm -rf "$fixture_dir"
    node --input-type=module - "$fixture_dir" "$fixture_mib" <<'NODE'
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [fixtureDir, fixtureMiB] = process.argv.slice(2);
const mib = Number(fixtureMiB);
const bytes = mib * 1024 * 1024;
if (!Number.isInteger(mib) || !Number.isInteger(bytes) || bytes <= 0) {
  throw new Error(`Invalid fixture size: ${fixtureMiB}`);
}

const pomBytes = 512;
const shaBytes = 40;
const artifacts =
  mib <= 4 ? 128 : mib <= 16 ? 512 : mib <= 64 ? 1024 : 2048;
const sidecarBytes = artifacts * (pomBytes + shaBytes);
const jarBytes = bytes - sidecarBytes;
if (jarBytes <= artifacts) {
  throw new Error(
    `${fixtureMiB} MiB is too small for ${artifacts} Maven artifacts`,
  );
}
const baseJarBytes = Math.floor(jarBytes / artifacts);
const extraJarBytes = jarBytes % artifacts;

let state = 0x9e3779b9;

async function writeRandomFile(file, size) {
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "w");
  const chunk = Buffer.alloc(Math.min(64 * 1024, size));
  let written = 0;
  try {
    while (written < size) {
      const length = Math.min(chunk.length, size - written);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        chunk[index] = state & 0xff;
      }
      await handle.write(chunk, 0, length);
      written += length;
    }
  } finally {
    await handle.close();
  }
}

function paddedPom(group, artifact, version) {
  const xml = `<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version></project>\n`;
  return Buffer.from(xml.padEnd(pomBytes, " ").slice(0, pomBytes));
}

function sha1Sidecar(seed) {
  let value = seed + 1;
  let text = "";
  while (text.length < shaBytes) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    text += (value >>> 0).toString(16).padStart(8, "0");
  }
  return Buffer.from(text.slice(0, shaBytes));
}

for (let index = 0; index < artifacts; index += 1) {
  const group = `com.example.group${String(index % 64).padStart(2, "0")}.depth${String(Math.floor(index / 64) % 32).padStart(2, "0")}`;
  const artifact = `artifact-${String(index).padStart(4, "0")}`;
  const version = `1.${index % 17}.${Math.floor(index / 17)}`;
  const directory = join(
    fixtureDir,
    ...group.split("."),
    artifact,
    version,
  );
  const jar = join(directory, `${artifact}-${version}.jar`);
  const pom = join(directory, `${artifact}-${version}.pom`);
  const sha1 = join(directory, `${artifact}-${version}.jar.sha1`);
  await writeRandomFile(jar, baseJarBytes + (index < extraJarBytes ? 1 : 0));
  await writeFile(pom, paddedPom(group, artifact, version));
  await writeFile(sha1, sha1Sidecar(index));
}
NODE
    ;;
  expected-file-count)
    fixture_mib=${2:?fixture size in MiB is required}
    node --input-type=module - "$fixture_mib" <<'NODE'
const [fixtureMiB] = process.argv.slice(2);
const mib = Number(fixtureMiB);
if (!Number.isInteger(mib) || mib <= 0) {
  throw new Error(`Invalid fixture size: ${fixtureMiB}`);
}
const artifacts =
  mib <= 4 ? 128 : mib <= 16 ? 512 : mib <= 64 ? 1024 : 2048;
console.log(artifacts * 3);
NODE
    ;;
  verify-fixture)
    fixture_mib=${2:?fixture size in MiB is required}
    node --input-type=module - "$fixture_dir" "$fixture_mib" <<'NODE'
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const [fixtureDir, fixtureMiB] = process.argv.slice(2);
const mib = Number(fixtureMiB);
const expectedBytes = mib * 1024 * 1024;
if (!Number.isInteger(mib) || !Number.isInteger(expectedBytes) || mib <= 0) {
  throw new Error(`Invalid fixture size: ${fixtureMiB}`);
}
const artifacts =
  mib <= 4 ? 128 : mib <= 16 ? 512 : mib <= 64 ? 1024 : 2048;
const expectedFiles = artifacts * 3;

async function walk(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await walk(path);
      files += child.files;
      bytes += child.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await stat(path)).size;
    }
  }
  return { files, bytes };
}

const actual = await walk(fixtureDir);
if (actual.bytes !== expectedBytes) {
  throw new Error(
    `Cache-save fixture is ${actual.bytes} bytes, expected ${expectedBytes}`,
  );
}
if (actual.files !== expectedFiles) {
  throw new Error(
    `Cache-save fixture has ${actual.files} files, expected ${expectedFiles}`,
  );
}
NODE
    ;;
  file-count)
    node --input-type=module - "$fixture_dir" <<'NODE'
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const [fixtureDir] = process.argv.slice(2);

async function count(directory) {
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files += await count(path);
    } else if (entry.isFile()) {
      files += 1;
    }
  }
  return files;
}

console.log(await count(fixtureDir));
NODE
    ;;
  remove-one-file)
    node --input-type=module - "$fixture_dir" <<'NODE'
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const [fixtureDir] = process.argv.slice(2);

async function firstFile(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await firstFile(path);
      if (found) return found;
    } else if (entry.isFile()) {
      return path;
    }
  }
  return null;
}

const file = await firstFile(fixtureDir);
if (!file) throw new Error(`No fixture file found under ${fixtureDir}`);
await rm(file);
NODE
    ;;
  install-client)
    arm_dir=${2:?setup-java checkout directory is required}
    if [ -f "$arm_dir/package-lock.json" ]; then
      npm --prefix "$arm_dir" ci --ignore-scripts --no-audit --no-fund
    else
      npm --prefix "$arm_dir" install --ignore-scripts --no-audit --no-fund
    fi
    node --input-type=module - "$PWD/$arm_dir/package.json" <<'NODE'
import { createRequire } from "node:module";

// `@actions/cache` publishes an `exports` map with no "." entry, so requiring it
// by package name fails outright. Resolving its manifest and requiring the file
// its `main` points at goes around the map, and keeps working whichever version
// a given setup-java ref happens to pin.
function loadCacheClient(require, callerManifest) {
  const { readFileSync } = require("node:fs");
  const { dirname, join } = require("node:path");
  let manifestPath;
  try {
    manifestPath = require.resolve("@actions/cache/package.json");
  } catch {
    // Some versions do not expose "./package.json" through the map either, in
    // which case the install layout is the only thing left to go on.
    manifestPath = join(
      dirname(callerManifest),
      "node_modules",
      "@actions",
      "cache",
      "package.json",
    );
  }
  const packageJson = JSON.parse(readFileSync(manifestPath, "utf8"));
  return require(join(dirname(manifestPath), packageJson.main ?? "lib/cache.js"));
}

const [manifest] = process.argv.slice(2);
const require = createRequire(manifest);
loadCacheClient(require, manifest);
NODE
    ;;
  save)
    arm_dir=${2:?setup-java checkout directory is required}
    key=${3:?cache key is required}
    results_file=${4:-}
    sample=${5:-}
    arm=${6:-}
    slot=${7:-}
    if [ ! -d "$fixture_dir" ]; then
      echo "Cache-save fixture is missing at $fixture_dir" >&2
      exit 1
    fi
    node --input-type=module - "$PWD/$arm_dir/package.json" "$fixture_dir" "$key" \
      "$results_file" "$sample" "$arm" "$slot" <<'NODE'
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// `@actions/cache` publishes an `exports` map with no "." entry, so requiring it
// by package name fails outright. Resolving its manifest and requiring the file
// its `main` points at goes around the map, and keeps working whichever version
// a given setup-java ref happens to pin.
function loadCacheClient(require, callerManifest) {
  const { readFileSync } = require("node:fs");
  const { dirname, join } = require("node:path");
  let manifestPath;
  try {
    manifestPath = require.resolve("@actions/cache/package.json");
  } catch {
    // Some versions do not expose "./package.json" through the map either, in
    // which case the install layout is the only thing left to go on.
    manifestPath = join(
      dirname(callerManifest),
      "node_modules",
      "@actions",
      "cache",
      "package.json",
    );
  }
  const packageJson = JSON.parse(readFileSync(manifestPath, "utf8"));
  return require(join(dirname(manifestPath), packageJson.main ?? "lib/cache.js"));
}

const [manifest, fixtureDir, key, resultsFile, sample, arm, slot] =
  process.argv.slice(2);
const require = createRequire(manifest);
const cache = loadCacheClient(require, manifest);

const started = Date.now();
const cacheId = await cache.saveCache([fixtureDir], key);
const elapsedMs = Date.now() - started;
console.log(`Saved ${key} as cache ${cacheId} in ${elapsedMs} ms`);
if (resultsFile) {
  const { record } = await import(
    pathToFileURL(`${process.cwd()}/scripts/measure.mjs`).href
  );
  await record(resultsFile, [sample, arm, slot], elapsedMs);
}
NODE
    ;;
  *)
    echo "Unsupported command: $command" >&2
    exit 1
    ;;
esac
