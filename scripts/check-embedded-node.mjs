// Syntax-check the JavaScript embedded in shell heredocs.
//
// Several benchmark helpers run node inline, via `node --input-type=module -
// <<'NODE'`. That code is a string as far as every other check here is
// concerned: prettier does not format it, `node --test` never imports it, and
// shellcheck sees an opaque heredoc. A syntax error in one of those blocks is
// therefore invisible until a runner reaches it, which costs a whole benchmark
// run to discover — that is exactly how `Identifier 'manifest' has already been
// declared` reached a live job.

import { readFile, writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { glob } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const BLOCK = /<<'NODE'\n([\s\S]*?)\nNODE\n/g;

export function extractBlocks(source) {
  return [...source.matchAll(BLOCK)].map((match, index) => ({
    index,
    code: match[1],
    // Line of the heredoc opener, so a failure points somewhere useful.
    line: source.slice(0, match.index).split("\n").length,
  }));
}

export async function checkBlock(block, file) {
  const scratch = join(
    tmpdir(),
    `embedded-${process.pid}-${file.replace(/\W/g, "_")}-${block.index}.mjs`,
  );
  await writeFile(scratch, block.code);
  try {
    await run("node", ["--check", scratch]);
    return null;
  } catch (error) {
    return `${file}:${block.line}: ${String(error.stderr).trim().split("\n").pop()}`;
  } finally {
    await unlink(scratch).catch(() => {});
  }
}

export async function main() {
  const files = [];
  for await (const file of glob("scripts/*.sh")) files.push(file);
  files.sort();

  const failures = [];
  let checked = 0;
  for (const file of files) {
    for (const block of extractBlocks(await readFile(file, "utf8"))) {
      checked += 1;
      const failure = await checkBlock(block, file);
      if (failure) failures.push(failure);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Embedded node scripts failed to parse:\n${failures.map((failure) => `  ${failure}`).join("\n")}`,
    );
  }
  console.log(
    `${checked} embedded node scripts parse in ${files.length} files`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
