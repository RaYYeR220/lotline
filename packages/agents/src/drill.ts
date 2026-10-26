import { Markovian, runDrill, type DrillReport, type DrillState } from "@lotline/markovian";
import { WorldModel } from "@lotline/world-model";
import type { AgentContext } from "./context.ts";
import type { RunDeps } from "./orchestrator.ts";
import { assess } from "./critic.ts";
import { canonicalLot } from "./lotcodes.ts";
import { mapSources, type SourceMap } from "./mapper.ts";
import { addDays, q } from "./sql.ts";
import { traceForward } from "./tracer.ts";

export interface DrillResult {
  report: DrillReport;
  lots: string[];
  window: { from: string; to: string };
  /** Nightshift's judged morning brief, when a racing lane is available. */
  brief: { jobId?: string; status: string; note: string };
}

/**
 * Nightly mock recall: for a sample of active lots, trace each one forward the way a real recall would,
 * in bounded chunks (Markovian), and count where the records would not hold up today.
 */
export async function nightlyDrill(deps: RunDeps, opts: { sample?: number; days?: number; asOf?: string } = {}): Promise<DrillResult> {
  const ctx: AgentContext = { ...deps, world: new WorldModel({ storage: "memory", namespace: "drill" }), asOf: opts.asOf ?? new Date().toISOString().slice(0, 10), maxRetries: 0 };
  const { map } = await mapSources(ctx);
  const asOf = opts.asOf ?? (await latestShipDate(ctx, map));
  const window = { from: addDays(asOf, -(opts.days ?? 14)), to: asOf };
  const sp = map["packer.shipments"];
  const recent = await ctx.data.query(
    `SELECT DISTINCT ${sp.lot} FROM packer.shipments WHERE ${sp.date} >= ${q(window.from)} AND ${sp.date} <= ${q(window.to)} ORDER BY ${sp.lot}`,
    { agent: "DrillAgent", purpose: "active lots in the drill window" },
  );
  const all = recent.rows.map((r) => canonicalLot(String(r[sp.lot!])));
  const step = Math.max(1, Math.floor(all.length / (opts.sample ?? 24)));
  const lots = all.filter((_, i) => i % step === 0).slice(0, opts.sample ?? 24);

  const m = new Markovian({ chunkConfig: { carryoverTokens: 128 } });
  const report = await runDrill(
    m,
    lots,
    async (lot: string, state: DrillState) => {
      const world = new WorldModel({ storage: "memory", namespace: `drill-${lot}` });
      const graph = await traceForward({ ...ctx, world }, [lot], "", map);
      const reasons = graph.links.flatMap((l) => {
        const a = assess(l, graph.checks.get(l.id)!);
        return a.verdict === "contested" ? [`${l.kind} ${l.to}: ${a.reasons.join("; ")}`] : [];
      });
      const reachedStores = graph.links.some((l) => l.kind === "shipped-to");
      const supplier = "packer";
      const bucket = state.bySupplier[supplier] ?? { ok: 0, gaps: 0 };
      const gaps = [...state.gaps];
      if (reasons.length || !reachedStores) {
        bucket.gaps++;
        gaps.push({ lot, reason: reasons[0] ?? "no downstream records found" });
      } else bucket.ok++;
      return { traced: state.traced + 1, gaps, bySupplier: { ...state.bySupplier, [supplier]: bucket } };
    },
    { chunkSize: 4, trace: ctx.trace, agent: "DrillAgent" },
  );

  ctx.trace.emit({
    agent_name: "DrillAgent", action: "drill.done", input_summary: `${lots.length} lots shipped ${window.from}..${window.to}`,
    output_summary: `${report.traced} traced, ${report.gaps.length} would not hold up in a recall today`, status: "success",
    detail: { gaps: report.gaps, chunks: report.chunks.length },
  });
  return { report, lots, window, brief: { status: "local", note: "summary computed locally" } };
}

async function latestShipDate(ctx: AgentContext, map: SourceMap): Promise<string> {
  const sp = map["packer.shipments"];
  const r = await ctx.data.query(`SELECT MAX(${sp.date}) AS d FROM packer.shipments`, { agent: "DrillAgent", purpose: "latest activity" });
  return String(Object.values(r.rows[0] ?? {})[0] ?? new Date().toISOString()).slice(0, 10);
}
