import type { DataLayer, ModelGateway } from "@lotline/adapters";
import type { LotlineConfig, RecallScope, RunResult, TraceLog } from "@lotline/core";
import { WorldModel } from "@lotline/world-model";
import type { ActionGate, AgentContext, PartnerMemory } from "./context.ts";
import { review } from "./critic.ts";
import { intake } from "./intake.ts";
import { mapSources } from "./mapper.ts";
import { learnQuirks } from "./memory.ts";
import { plan } from "./planner.ts";
import { report } from "./reporter.ts";
import { q } from "./sql.ts";
import { resolveImplicated, traceForward } from "./tracer.ts";

export interface RecallInput {
  notice?: string;
  openFdaRecallNumber?: string;
  asOf?: string;
  options?: { maxRetries?: number };
}

export interface RunDeps {
  cfg: LotlineConfig;
  data: DataLayer;
  models: ModelGateway;
  memory: PartnerMemory;
  gate: ActionGate;
  trace: TraceLog;
  /** Defaults to an in-memory World Model scoped to this run. */
  world?: WorldModel;
}

/** Looks an FDA recall number up in the enforcement reports registered in the data layer. */
async function noticeFromRecallNumber(ctx: AgentContext, recallNumber: string): Promise<string | null> {
  try {
    const res = await ctx.data.query(`SELECT * FROM fda.enforcement WHERE recall_number = ${q(recallNumber)}`, { agent: "IntakeAgent", purpose: `FDA enforcement report ${recallNumber}`, timeoutMs: 30_000 });
    const r = res.rows[0];
    if (!r) return null;
    return Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("\n");
  } catch {
    return null;
  }
}

/**
 * One recall run: intake → source mapping → forward trace → critique (retries, panels) → plan → report.
 * Every step writes to the run trace; nothing here sends a notice or places a hold by itself.
 */
export async function runRecall(input: RecallInput, deps: RunDeps): Promise<RunResult> {
  const started = Date.now();
  const ctx: AgentContext = {
    cfg: deps.cfg, data: deps.data, models: deps.models, memory: deps.memory, gate: deps.gate, trace: deps.trace,
    world: deps.world ?? new WorldModel({ storage: "memory", namespace: deps.trace.runId }),
    asOf: input.asOf ?? new Date().toISOString().slice(0, 10),
    maxRetries: input.options?.maxRetries ?? 2,
  };
  const mode = deps.data.backend === "duckdb-sample" ? "sample" : "live";
  ctx.trace.emit({ agent_name: "Orchestrator", action: "run.start", input_summary: (input.notice ?? input.openFdaRecallNumber ?? "").slice(0, 120), output_summary: `mode ${mode}`, target_agent: "IntakeAgent", status: "success" });

  let status: RunResult["status"] = "complete";
  let notice = input.notice ?? "";
  if (!notice && input.openFdaRecallNumber) notice = (await noticeFromRecallNumber(ctx, input.openFdaRecallNumber)) ?? `Recall number ${input.openFdaRecallNumber}`;

  const scope: RecallScope = await intake(ctx, notice);
  const empty = (why: string): RunResult => {
    ctx.trace.emit({ agent_name: "Orchestrator", action: "run.done", input_summary: scope.noticeId, output_summary: why, status: "success" });
    return {
      runId: ctx.trace.runId, status, mode, scope, links: [], actions: [], spreadsheet: { csv: "", rows: 0 }, drafts: [],
      stats: { queries: ctx.trace.events().filter((e) => e.action.startsWith("zetaris.")).length, modelCalls: deps.models.callCount(), races: 0, retries: 0, escalations: 0, ms: Date.now() - started },
    };
  };

  let map, quirks;
  try {
    ({ map, quirks } = await mapSources(ctx));
  } catch (err) {
    status = "degraded";
    ctx.trace.emit({ agent_name: "Orchestrator", action: "run.degraded", input_summary: "source mapping", output_summary: (err as Error).message.slice(0, 200), status: "error" });
    return empty("data layer unavailable; nothing traced, nothing cleared");
  }

  const { lots, commodity } = await resolveImplicated(ctx, scope, map);
  if (!lots.length) return empty("no implicated lots in partner records: the network did not handle this product");

  let graph;
  try {
    graph = await traceForward(ctx, lots, commodity, map);
  } catch (err) {
    status = "degraded";
    ctx.trace.emit({ agent_name: "Orchestrator", action: "run.degraded", input_summary: "forward trace", output_summary: (err as Error).message.slice(0, 200), status: "error" });
    return empty("trace interrupted; no location cleared");
  }
  const { retries, panels } = await review(ctx, graph, quirks);
  const { actions } = await plan(ctx, graph);
  const { spreadsheet, drafts } = await report(ctx, scope, graph, actions);
  await learnQuirks(ctx.memory, graph, ctx.trace.runId, ctx.trace);

  const events = ctx.trace.events();
  const result: RunResult = {
    runId: ctx.trace.runId, status, mode, scope, links: graph.links, actions, spreadsheet, drafts,
    stats: {
      queries: events.filter((e) => e.action.startsWith("zetaris.")).length,
      modelCalls: deps.models.callCount(),
      races: panels,
      retries,
      escalations: events.filter((e) => e.status === "escalated").length,
      ms: Date.now() - started,
    },
  };
  ctx.trace.emit({
    agent_name: "Orchestrator", action: "run.done", input_summary: scope.noticeId,
    output_summary: `${actions.filter((a) => a.kind === "PULL").length} PULL, ${actions.filter((a) => a.kind === "HOLD").length} HOLD, ${actions.filter((a) => a.kind === "CLEAR").length} CLEAR in ${Math.round(result.stats.ms / 1000)} s`,
    status: "success",
  });
  return result;
}
