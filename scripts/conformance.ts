// Runs a vendored Meterless conformance runner against one of our engines.
//
//   pnpm conformance:wm             print the scorecard
//   pnpm conformance:wm --save      also write it to docs/conformance/<engine>.txt
//
// Usage: tsx scripts/conformance.ts <engine> [--save]
// The runner is spawned as `node --import tsx <runner>` (no shell, so it
// behaves the same on Windows) with the engine's IMPL variable pointing at our
// implementation. The path is passed repo-relative; the runner resolves it.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface EngineSuite {
  /** environment variable the official runner reads the implementation path from */
  implVar: string;
  runner: string;
  impl: string;
  script: string;
}

const ENGINES: Record<string, EngineSuite> = {
  "world-model": {
    implVar: "WORLD_MODEL_IMPL",
    runner: "packages/engines/vendor/meterless/world-model/runner.ts",
    impl: "packages/engines/world-model/src/index.ts",
    script: "conformance:wm",
  },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [engine, ...flags] = process.argv.slice(2);
const suite = engine ? ENGINES[engine] : undefined;
if (!suite) {
  console.error(`usage: tsx scripts/conformance.ts <${Object.keys(ENGINES).join("|")}> [--save]`);
  process.exit(2);
}

const run = spawnSync(process.execPath, ["--import", "tsx", suite.runner], {
  cwd: root,
  env: { ...process.env, [suite.implVar]: suite.impl },
  encoding: "utf8",
});
if (run.error) {
  console.error(`conformance: could not start the runner: ${run.error.message}`);
  process.exit(2);
}
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);

if (flags.includes("--save")) {
  const out = path.join(root, "docs", "conformance", `${engine}.txt`);
  const header = [
    `$ pnpm ${suite.script}`,
    `runner: ${suite.runner} (Meterless, Apache-2.0, vendored unmodified)`,
    `node ${process.version}, ${new Date().toISOString().slice(0, 10)}, exit code ${run.status}`,
    "",
  ].join("\n");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${header}${run.stdout}${run.stderr}`, "utf8");
  console.log(`\nsaved ${path.relative(root, out).replaceAll("\\", "/")}`);
}

process.exit(run.status ?? 1);
