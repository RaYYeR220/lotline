// Command-line entry point: run one recall trace and print the actions.
//
//   npx tsx run.ts --example input_examples/example_1.json
//   npx tsx run.ts --notice "Recall of ..."        (SAMPLE_MODE=true to run without Zetaris or Nightshift)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TraceLog, loadConfig } from "@lotline/core";
import { createRunDeps, runRecall, type RecallInput } from "@lotline/agents";

function args(): { input: RecallInput; out?: string; quiet: boolean } {
  const a = process.argv.slice(2);
  const get = (flag: string) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);
  const example = get("--example");
  const input: RecallInput = example ? JSON.parse(readFileSync(example, "utf8")) : { notice: get("--notice"), openFdaRecallNumber: get("--recall") };
  if (!input.notice && !input.openFdaRecallNumber) {
    console.error("usage: run.ts --example <file.json> | --notice <text> | --recall <F-0000-0000> [--out result.json] [--quiet]");
    process.exit(2);
  }
  return { input, out: get("--out"), quiet: a.includes("--quiet") };
}

const { input, out, quiet } = args();
const cfg = loadConfig();
const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const trace = new TraceLog(runId, { dir: cfg.logsDir, stdout: !quiet });
const result = await runRecall(input, createRunDeps(cfg, trace));

const summary = result.actions.map((a) => `${a.kind.padEnd(8)} ${a.locationId.padEnd(6)} ${a.locationName}${a.approval === "pending" ? "  [approval pending]" : ""}`).join("\n");
console.error(`\n${result.runId} (${result.mode}, ${result.status}) — ${result.scope.commodity}, lots ${result.scope.lotCodes.join(", ") || `${result.scope.dateFrom}..${result.scope.dateTo}`}\n${summary || "no locations affected"}`);
console.error(`spreadsheet rows ${result.spreadsheet.rows}; ${result.stats.queries} queries, ${result.stats.modelCalls} model calls, ${result.stats.retries} retries, ${result.stats.races} panels; ${(result.stats.ms / 1000).toFixed(1)} s; trace logs/${result.runId}.jsonl`);
if (out) {
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
}
