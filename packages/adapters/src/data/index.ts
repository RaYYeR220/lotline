import type { LotlineConfig, TraceLog } from "@lotline/core";
import { DuckDbSample } from "./duckdb.ts";
import type { DataLayer } from "./types.ts";
import { ZetarisClient } from "./zetaris.ts";

export * from "./types.ts";
export { DuckDbSample } from "./duckdb.ts";
export { ZetarisClient, toRows } from "./zetaris.ts";

export function createDataLayer(cfg: LotlineConfig, trace: TraceLog, samplePath = "data/sample/world.duckdb"): DataLayer {
  if (cfg.sampleMode) return new DuckDbSample(samplePath, trace);
  if (!cfg.zetaris.token || !cfg.zetaris.orgId) {
    throw new Error("Zetaris is not configured: set ZETARIS_API_TOKEN and ZETARIS_ORG_ID, or run with SAMPLE_MODE=true");
  }
  return new ZetarisClient({ baseUrl: cfg.zetaris.baseUrl, token: cfg.zetaris.token, orgId: cfg.zetaris.orgId }, trace);
}
