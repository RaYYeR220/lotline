// HTTP entry point: the recall API plus the built web UI.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { TraceLog, loadConfig } from "@lotline/core";
import { ScoutGate, createRunDeps, runRecall } from "@lotline/agents";
import { buildServer } from "./server.ts";

const cfg = loadConfig();
const gates = new Map<string, ScoutGate>();
const webDir = path.resolve(process.env.LOTLINE_WEB_DIR ?? "apps/web/dist");

// Example notices: the bundled sample notices (FDA enforcement-report style) the demo world can answer.
const examplesFile = path.resolve(process.env.LOTLINE_EXAMPLES ?? "data/sample/notices.json");
const examples = existsSync(examplesFile)
  ? (JSON.parse(readFileSync(examplesFile, "utf8")) as { noticeId: string; text: string; fields?: Record<string, string> }[]).map((n) => ({
      id: n.noticeId,
      title: `${n.fields?.recalling_firm ?? "Recall"}: ${(n.fields?.product_description ?? n.text.split(/\r?\n/)[3] ?? "").slice(0, 60)}`,
      notice: n.text,
    }))
  : [];

const { app } = buildServer({
  examples,
  mode: cfg.sampleMode ? "sample" : "live",
  logsDir: cfg.logsDir,
  staticDir: existsSync(webDir) ? webDir : undefined,
  runner: async (input, { trace }: { runId: string; trace: TraceLog }) => {
    const deps = createRunDeps(cfg, trace);
    gates.set(trace.runId, deps.gate as ScoutGate);
    return runRecall(input, deps);
  },
  // An approval only counts if the contract it approves still verifies against its signature.
  approve: (record, contractId) => (gates.get(record.runId)?.verify(contractId) ? { ok: true } : { ok: false, reason: "contract signature does not verify" }),
});

const port = Number(process.env.PORT ?? 8000);
await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
console.error(`lotline api on :${port} (${cfg.sampleMode ? "sample mode" : "live: Zetaris + Nightshift"})`);
