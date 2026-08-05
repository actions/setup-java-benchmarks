// Millisecond-resolution stopwatch for in-job benchmark slots.
//
// The GitHub Actions API reports step `started_at`/`completed_at` with
// one-second resolution. Setup steps take two to six seconds, so reading
// durations from the API quantizes each measurement to +/- 500 ms — an error of
// the same magnitude as the effects these benchmarks try to detect. Timing the
// step from inside the job instead keeps millisecond precision.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const CLOCK_FILE = ".benchmark-clock";

export async function start(clockFile = CLOCK_FILE) {
  await writeFile(clockFile, String(Date.now()));
}

export async function stop(clockFile = CLOCK_FILE) {
  const started = Number(await readFile(clockFile, "utf8"));
  if (!Number.isFinite(started)) {
    throw new Error(`No valid start timestamp in ${clockFile}`);
  }
  return Date.now() - started;
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export async function record(resultsFile, fields, elapsedMs) {
  await mkdir(dirname(resultsFile), { recursive: true });
  const line = [...fields, elapsedMs].map(csvValue).join(",");
  await appendFile(resultsFile, `${line}\n`);
}

export async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case "start": {
      await start(rest[0] ?? CLOCK_FILE);
      return;
    }
    case "record": {
      const [resultsFile, ...fields] = rest;
      if (!resultsFile) throw new Error("record requires a results file");
      const elapsedMs = await stop(CLOCK_FILE);
      await record(resultsFile, fields, elapsedMs);
      console.log(`${fields.join("/")}: ${elapsedMs} ms`);
      return;
    }
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv.slice(2));
}
