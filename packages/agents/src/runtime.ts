import { existsSync, readFileSync } from "node:fs";
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

/** Everything a run needs, wired for live mode (Zetaris + Nightshift) or sample mode (bundled snapshot). */
export function createRunDeps(cfg: LotlineConfig, trace: TraceLog, opts: { stateDir?: string } = {}): RunDeps {
  const stateDir = opts.stateDir ?? process.env.LOTLINE_STATE_DIR ?? "data/state";
  const models = cfg.sampleMode
    ? new SampleGateway(trace)
    : new NightshiftGateway({ ...cfg, nightshift: { ...cfg.nightshift, token: nightshiftToken(cfg) } }, trace, { record: /^(1|true)$/i.test(process.env.RECORD_CACHE ?? "") });
  return {
    cfg,
    data: createDataLayer(cfg, trace),
    models,
    memory: new HmemPartnerMemory(path.join(stateDir, cfg.sampleMode ? "hmem-sample" : "hmem"), trace),
    gate: new ScoutGate(cfg.contractSecret, trace),
    trace,
  };
}
