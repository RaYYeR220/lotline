// Runs the vendored Meterless H-MEM conformance runner against @lotline/hmem.
//
//   pnpm conformance:hmem           print the scorecard
//   pnpm conformance:hmem --save    also write it to docs/conformance/hmem.txt
//
// The runner is spawned as `node --import tsx <runner>` (no shell, so it
// behaves the same on Windows). HMEM_IMPL is an absolute path with forward
// slashes, as the runner expects; the saved copy shows it repo-relative.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = "packages/engines/vendor/meterless/hmem/runner.ts";
const impl = path.join(root, "packages/engines/hmem/src/index.ts").replaceAll("\\", "/");

const run = spawnSync(process.execPath, ["--import", "tsx", path.join(root, runner)], {
  cwd: root,
  env: { ...process.env, HMEM_IMPL: impl },
  encoding: "utf8",
});
if (run.error) {
  console.error(`conformance: could not start the runner: ${run.error.message}`);
  process.exit(2);
}
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);

if (process.argv.includes("--save")) {
  const out = path.join(root, "docs", "conformance", "hmem.txt");
  const rootPrefix = `${root.replaceAll("\\", "/")}/`;
  const header = [
    "$ pnpm conformance:hmem",
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
