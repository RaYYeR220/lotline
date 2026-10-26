import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NightshiftGateway, SampleGateway, createDataLayer } from "@lotline/adapters";
import type { LotlineConfig, TraceLog } from "@lotline/core";
import { ScoutGate } from "./gate.ts";
import { HmemPartnerMemory } from "./memory.ts";
import type { RunDeps } from "./orchestrator.ts";

/** Nightshift's local token: from the environment, else from the running Nightshift install on this machine. */
export function nightshiftToken(cfg: LotlineConfig): string | undefined {
  if (cfg.nightshift.token) return cfg.nightshift.token;
  const file = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ai.meterless.runtime", "proxy-token") : "";
  return file && existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

/**
 * Partner memory for a run. Live runs share one persistent store, so what one recall learns the next one uses.
 * Sample runs (and recordings made for them) start from the bundled snapshot in a scratch copy, so every
 * sample run sees the same memory and replays the same recorded model answers.
 */
function memoryDir(cfg: LotlineConfig, stateDir: string, runId: string, recording: boolean): string {
  if (!cfg.sampleMode && !recording) return path.join(stateDir, "hmem");
  const scratch = mkdtempSync(path.join(tmpdir(), `lotline-hmem-${runId}-`));
  const snapshot = path.resolve("data/sample/hmem");
  if (existsSync(snapshot)) cpSync(snapshot, scratch, { recursive: true });
  return scratch;
}

/**
 * Everything a run needs. Live: Zetaris + Nightshift. Sample: the bundled snapshot and recorded answers.
 * `LOTLINE_DATA=sample` keeps live models but reads the bundled snapshot (used to record sample answers).
 */
export function createRunDeps(cfg: LotlineConfig, trace: TraceLog, opts: { stateDir?: string } = {}): RunDeps {
  const stateDir = opts.stateDir ?? process.env.LOTLINE_STATE_DIR ?? "data/state";
  const recording = /^(1|true)$/i.test(process.env.RECORD_CACHE ?? "");
  const dataCfg = process.env.LOTLINE_DATA === "sample" ? { ...cfg, sampleMode: true } : cfg;
  const models = cfg.sampleMode
    ? new SampleGateway(trace)
    : new NightshiftGateway({ ...cfg, nightshift: { ...cfg.nightshift, token: nightshiftToken(cfg) } }, trace, { record: recording });
  return {
    cfg,
    data: createDataLayer(dataCfg, trace),
    models,
    memory: new HmemPartnerMemory(memoryDir(cfg, stateDir, trace.runId, recording), trace),
    gate: new ScoutGate(cfg.contractSecret, trace),
    trace,
  };
}
