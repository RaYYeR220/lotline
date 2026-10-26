// Runs the vendored Meterless Markovian conformance runner against
// @lotline/markovian.
//
//   pnpm conformance:markovian           print the scorecard
//   pnpm conformance:markovian --save    also write it to docs/conformance/markovian.txt
//
// The runner is spawned as `node --import tsx <runner>` (no shell, so it
// behaves the same on Windows). MARKOVIAN_IMPL is an absolute path with
// forward slashes, as the runner expects; the saved copy shows it repo-relative.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = "packages/engines/vendor/meterless/markovian/runner.ts";
const impl = path.join(root, "packages/engines/markovian/src/index.ts").replaceAll("\\", "/");

const run = spawnSync(process.execPath, ["--import", "tsx", path.join(root, runner)], {
  cwd: root,
  env: { ...process.env, MARKOVIAN_IMPL: impl },
  encoding: "utf8",
});
if (run.error) {
  console.error(`conformance: could not start the runner: ${run.error.message}`);
  process.exit(2);
}
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);

if (process.argv.includes("--save")) {
  const out = path.join(root, "docs", "conformance", "markovian.txt");
  const rootPrefix = `${root.replaceAll("\\", "/")}/`;
  const header = [
    "$ pnpm conformance:markovian",
    `runner: ${runner} (Meterless, Apache-2.0, vendored unmodified)`,
    `node ${process.version}, ${new Date().toISOString().slice(0, 10)}, exit code ${run.status}`,
    "(the absolute implementation path is shown relative to the repo root)",
    "",
  ].join("\n");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${header}${`${run.stdout}${run.stderr}`.replaceAll(rootPrefix, "")}`, "utf8");
  console.log(`\nsaved ${path.relative(root, out).replaceAll("\\", "/")}`);
}

process.exit(run.status ?? 1);
