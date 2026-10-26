/**
 * Runs the vendored Meterless Scout eval harness against our Scout engine.
 *
 *   pnpm conformance:scout              # run, print, write docs/conformance/scout.txt
 *   pnpm conformance:scout --out <file> # write the report somewhere else
 *   pnpm conformance:scout --no-write   # run and print only
 *
 * The upstream runner is kept byte-for-byte (see its NOTICE). It imports `yaml`,
 * which lives in @lotline/scout's devDependencies rather than next to the vendored
 * tree, so the child process gets a one-line resolve hook that answers that single
 * bare specifier from the scout package. Everything is passed as argv/env (no shell),
 * so Windows paths with spaces are safe.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessDir = path.join(root, "packages", "engines", "vendor", "meterless", "scout-evals");
const runner = path.join(harnessDir, "runner", "index.ts");
const scoutPkg = path.join(root, "packages", "engines", "scout");
const impl = path.join(scoutPkg, "src", "index.ts");

// Resolve `yaml` as if it were imported from inside @lotline/scout.
const yamlParent = pathToFileURL(path.join(scoutPkg, "package.json")).href;
const resolveHook =
  "data:text/javascript," +
  encodeURIComponent(
    `import { registerHooks } from "node:module";
     registerHooks({ resolve(spec, ctx, next) {
       return spec === "yaml" ? next(spec, { ...ctx, parentURL: ${JSON.stringify(yamlParent)} }) : next(spec, ctx);
     } });`,
  );

export interface HarnessRun {
  status: number;
  output: string;
  report: string;
}

/** Spawn the upstream runner once and collect its console output and markdown report. */
export function runScoutHarness(filter = "all"): HarnessRun {
  const child = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", "--import", resolveHook, runner, filter],
    {
      cwd: root,
      env: { ...process.env, SCOUT_IMPL: impl },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (child.error) throw child.error;
  let report = "";
  try {
    report = readFileSync(path.join(harnessDir, "reports", "latest.md"), "utf8");
  } catch {
    // the runner exits before writing a report when it cannot load the engine
  }
  return { status: child.status ?? 1, output: `${child.stdout ?? ""}${child.stderr ?? ""}`, report };
}

function main(argv: string[]): number {
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? path.resolve(argv[outIdx + 1]!) : path.join(root, "docs", "conformance", "scout.txt");
  const write = !argv.includes("--no-write");

  const run = runScoutHarness("all");
  process.stdout.write(run.output);

  if (write) {
    // Keep machine-specific absolute paths out of the committed report.
    const relative = (s: string) => s.split(root + path.sep).join("").split(root.replaceAll("\\", "/") + "/").join("").split(root).join(".");
    const text = [
      "Scout Intent engine - Meterless eval harness (corpus v1, thresholds v1)",
      `command : SCOUT_IMPL=packages/engines/scout/src/index.ts tsx packages/engines/vendor/meterless/scout-evals/runner/index.ts all`,
      `node    : ${process.version}`,
      `exit    : ${run.status} (${run.status === 0 ? "every hard floor and ceiling met" : "gate failed"})`,
      "",
      "---- runner output ----",
      relative(run.output.trimEnd()),
      "",
      "---- runner report (reports/latest.md) ----",
      relative(run.report.trimEnd()),
      "",
    ].join("\n");
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(`\nconformance report saved to ${path.relative(root, out)}`);
  }
  return run.status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
