// Times one cache save using the `@actions/cache` client that a given
// setup-java ref resolves, so the arms differ by exactly the client code under
// test.
//
// Deliberately dependency-free: this file is committed unbundled and runs
// straight from the repository, so it may only use node built-ins. Inputs are
// read from `INPUT_*` rather than through `@actions/core` for the same reason.

// ESM, because the repository root declares `"type": "module"` and this file is
// run straight from the checkout rather than bundled.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";

function input(name, { required = false } = {}) {
  const value =
    process.env[`INPUT_${name.toUpperCase().replaceAll("-", "_")}`] ?? "";
  const trimmed = value.trim();
  if (required && trimmed === "") {
    throw new Error(`Input \`${name}\` is required`);
  }
  return trimmed;
}

// `@actions/cache` publishes an `exports` map with no "." entry, so requiring it
// by package name fails outright. Resolving its manifest and requiring the file
// its `main` points at goes around the map, and keeps working whichever version
// a given setup-java ref happens to pin.
function loadCacheClient(armDirectory) {
  const callerManifest = resolve(armDirectory, "package.json");
  const armRequire = createRequire(callerManifest);
  let manifestPath;
  try {
    manifestPath = armRequire.resolve("@actions/cache/package.json");
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
  return armRequire(
    join(dirname(manifestPath), packageJson.main ?? "lib/cache.js"),
  );
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function record(resultsFile, fields, elapsedMs) {
  const target = isAbsolute(resultsFile)
    ? resultsFile
    : resolve(process.cwd(), resultsFile);
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, `${[...fields, elapsedMs].map(csvValue).join(",")}\n`);
}

async function main() {
  const armDirectory = input("arm-directory", { required: true });
  const fixtureDirectory = input("fixture-directory", { required: true });
  const key = input("key", { required: true });
  const resultsFile = input("results-file");

  const cache = loadCacheClient(armDirectory);

  const started = Date.now();
  const cacheId = await cache.saveCache([fixtureDirectory], key);
  const elapsedMs = Date.now() - started;

  // `saveCache` logs a warning and returns -1 when the reservation fails, so a
  // slot that uploaded nothing still yields a duration. A benchmark that reports
  // a number for work it did not do is worse than one that fails.
  if (!Number.isFinite(cacheId) || cacheId <= 0) {
    throw new Error(
      `saveCache did not store ${key} (returned ${cacheId}). The measurement would be a ` +
        "failure path rather than an upload, so this slot is being failed instead of recorded.",
    );
  }

  console.log(`Saved ${key} as cache ${cacheId} in ${elapsedMs} ms`);
  if (resultsFile) {
    record(
      resultsFile,
      [input("sample"), input("arm"), input("slot")],
      elapsedMs,
    );
  }
}

main().catch((error) => {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
});
