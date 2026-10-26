// Lotline traceability drill on the Markovian engine. A drill walks a list of
// lots in fixed-size chunks; each chunk runs the per-lot step (a mini trace)
// and ends with a [STATE_CHECKPOINT] carrying only compressed counters: a
// cursor, per-supplier ok/gap counts and a short window of recent gaps. The
// full lot-by-lot log stays in the run history, so the carried state stays
// flat however many lots the drill covers, and a crashed drill resumes from
// the last finished chunk instead of starting over.

import type { TraceLog } from "@lotline/core";
import { estimateTokens } from "./config.ts";
import type { Markovian } from "./markovian.ts";
import type { CascadeLevel, Generator, MarkovianRun, RunStatus, TokenLabel } from "./types.ts";

export interface DrillGap {
  lot: string;
  reason: string;
}

export interface DrillState {
  /** Lots traced so far. */
  traced: number;
  /** Gaps known to this chunk: the carried window of recent gaps plus any found in the chunk. */
  gaps: DrillGap[];
  bySupplier: Record<string, { ok: number; gaps: number }>;
}

export type DrillStep = (lot: string, state: DrillState) => Promise<DrillState>;

export interface DrillOptions {
  /** Lots per chunk. Defaults to the smallest size that fits in maxChunks. */
  chunkSize?: number;
  /** How many recent gaps travel in the carried state (default 3). */
  keepRecentGaps?: number;
  goal?: string;
  abortSignal?: AbortSignal;
  /** When given, a summary event "markovian.drill" is written to the run trace. */
  trace?: Pick<TraceLog, "emit">;
  agent?: string;
}

export interface DrillChunkTelemetry {
  chunk: number;
  lots: number;
  firstLot?: string;
  lastLot?: string;
  /** Lots processed after this chunk. */
  cursor: number;
  carryoverInChars: number;
  carryoverInTokens: number;
  carryoverOutChars: number;
  carryoverOutTokens: number;
  outputTokens: number;
  cascadeLevel: CascadeLevel;
  newGaps: number;
  final: boolean;
}

export interface DrillReport {
  runId: string;
  status: RunStatus;
  lotsTotal: number;
  lotsProcessed: number;
  traced: number;
  /** Every gap found, in lot order, read back from the run history. */
  gaps: DrillGap[];
  bySupplier: Record<string, { ok: number; gaps: number }>;
  /** The compressed state as carried at the end (counters + recent gaps). */
  state: DrillState;
  chunks: DrillChunkTelemetry[];
  carryoverBudgetTokens: number;
  /** Largest checkpoint carried between chunks. */
  maxCarryoverTokens: number;
  tokens: { used: number; saved: number; efficiencyPercent: number; label: TokenLabel };
  resumed: number;
  error?: string;
}

interface DrillMeta {
  kind: "lotline.drill";
  lots: string[];
  chunkSize: number;
  keepRecentGaps: number;
}

const DEFAULT_RECENT_GAPS = 3;

export async function runDrill(m: Markovian, lots: string[], step: DrillStep, opts: DrillOptions = {}): Promise<DrillReport> {
  if (!Array.isArray(lots) || lots.length === 0) throw new RangeError("runDrill: needs at least one lot");
  const maxChunks = m.config.maxChunks;
  const perChunk = opts.chunkSize ?? Math.max(1, Math.ceil(lots.length / maxChunks));
  if (!Number.isInteger(perChunk) || perChunk < 1) throw new RangeError(`runDrill: chunkSize must be a positive integer, got ${perChunk}`);
  const needed = Math.ceil(lots.length / perChunk);
  if (needed > maxChunks) {
    throw new RangeError(`runDrill: ${lots.length} lots at ${perChunk} per chunk need ${needed} chunks but maxChunks is ${maxChunks}; raise chunkSize`);
  }
  const meta: DrillMeta = { kind: "lotline.drill", lots: [...lots], chunkSize: perChunk, keepRecentGaps: opts.keepRecentGaps ?? DEFAULT_RECENT_GAPS };
  const run = await m.run({
    goal: opts.goal ?? `Traceability drill over ${lots.length} lots`,
    generator: drillGenerator(meta, step, m.config.carryoverTokens),
    reflect: false,
    abortSignal: opts.abortSignal,
    meta: { ...meta },
  });
  return report(run, meta, opts);
}

/** Continue a crashed or aborted drill from its last checkpoint. */
export async function resumeDrill(
  m: Markovian,
  runId: string,
  step: DrillStep,
  opts: Pick<DrillOptions, "abortSignal" | "trace" | "agent"> = {},
): Promise<DrillReport> {
  const prior = m.history.get(runId);
  const meta = prior?.meta as DrillMeta | undefined;
  if (!prior || meta?.kind !== "lotline.drill") throw new Error(`resumeDrill: ${runId} is not a recorded drill`);
  const run = await m.resume(runId, {
    generator: drillGenerator(meta, step, prior.chunkConfig.carryoverTokens),
    reflect: false,
    abortSignal: opts.abortSignal,
  });
  return report(run, meta, opts);
}

// One generator call = one chunk of lots. It reads its position and counters
// from the carried state only, which is what makes the chain resumable.
function drillGenerator(meta: DrillMeta, step: DrillStep, budgetTokens: number): Generator {
  return async (_prompt, _attachments, _system, _stream, _abort, extras) => {
    const { cursor: start, state: carried } = readCheckpoint(extras?.carryover ?? "");
    const batch = meta.lots.slice(start, start + meta.chunkSize);
    const lines = [`Drill chunk ${extras?.step ?? "?"}: lots ${start + 1}-${start + batch.length} of ${meta.lots.length}`];
    let state = carried;
    for (const lot of batch) {
      const next = await step(lot, structuredClone(state));
      assertDrillState(next, lot);
      const found = newGaps(state.gaps, next.gaps);
      if (found.length === 0) lines.push(`OK ${lot}`);
      for (const g of found) lines.push(`GAP ${JSON.stringify(g)}`);
      state = next;
    }
    const cursor = start + batch.length;
    lines.push(`COUNTERS ${JSON.stringify({ cursor, traced: state.traced, bySupplier: state.bySupplier })}`);
    if (cursor >= meta.lots.length) {
      lines.push(`Status: drill complete, ${state.traced} lots traced across ${Object.keys(state.bySupplier).length} suppliers.`);
      lines.push("[TASK_COMPLETE]");
    } else {
      lines.push("[STATE_CHECKPOINT]", checkpoint(cursor, meta, state, budgetTokens));
    }
    return { text: lines.join("\n") };
  };
}

/** The carried state block: counters are exact, gaps are a short recent window. */
function checkpoint(cursor: number, meta: DrillMeta, state: DrillState, budgetTokens: number): string {
  const compact = Object.fromEntries(Object.entries(state.bySupplier).map(([s, v]) => [s, [v.ok, v.gaps]]));
  let recent = state.gaps.slice(-meta.keepRecentGaps);
  const build = () =>
    [
      `COMPLETED: traced lots 1-${cursor} of ${meta.lots.length}`,
      `REMAINING: ${meta.lots.length - cursor} lots`,
      `DECISIONS: cursor=${cursor}; counters=${JSON.stringify({ traced: state.traced, bySupplier: compact })}`,
      `CONTEXT: recentGaps=${JSON.stringify(recent)}`,
    ].join("\n");
  let block = build();
  while (block.length > budgetTokens * 4 && recent.length > 0) {
    recent = recent.slice(1);
    block = build();
  }
  if (block.length > budgetTokens * 4) {
    throw new Error(
      `drill counters for ${Object.keys(compact).length} suppliers need ${estimateTokens(block)} tokens, over carryoverTokens=${budgetTokens}; raise carryoverTokens`,
    );
  }
  return block;
}

function readCheckpoint(carryover: string): { cursor: number; state: DrillState } {
  if (!carryover.trim()) return { cursor: 0, state: { traced: 0, gaps: [], bySupplier: {} } };
  const cursor = /\bcursor=(\d+)/.exec(carryover)?.[1];
  const counters = /\bcounters=(\{.*\})\s*$/m.exec(carryover)?.[1];
  const recent = /\brecentGaps=(\[.*\])\s*$/m.exec(carryover)?.[1];
  if (cursor === undefined || counters === undefined) throw new Error("drill: the carried checkpoint has no cursor/counters");
  const c = JSON.parse(counters) as { traced: number; bySupplier: Record<string, [number, number]> };
  return {
    cursor: Number(cursor),
    state: {
      traced: c.traced,
      gaps: recent ? (JSON.parse(recent) as DrillGap[]) : [],
      bySupplier: Object.fromEntries(Object.entries(c.bySupplier).map(([s, [ok, gaps]]) => [s, { ok, gaps }])),
    },
  };
}

// Gaps in `after` that were not in `before` (multiset difference, order kept).
function newGaps(before: DrillGap[], after: DrillGap[]): DrillGap[] {
  const seen = new Map<string, number>();
  const key = (g: DrillGap) => `${g.lot}\u0000${g.reason}`;
  for (const g of before) seen.set(key(g), (seen.get(key(g)) ?? 0) + 1);
  const out: DrillGap[] = [];
  for (const g of after) {
    const n = seen.get(key(g)) ?? 0;
    if (n > 0) seen.set(key(g), n - 1);
    else out.push({ lot: g.lot, reason: g.reason });
  }
  return out;
}

function assertDrillState(s: DrillState, lot: string): void {
  const ok =
    s && typeof s.traced === "number" && Array.isArray(s.gaps) && s.bySupplier && typeof s.bySupplier === "object" &&
    s.gaps.every((g) => g && typeof g.lot === "string" && typeof g.reason === "string") &&
    Object.values(s.bySupplier).every((v) => v && typeof v.ok === "number" && typeof v.gaps === "number");
  if (!ok) throw new TypeError(`drill step returned a malformed state for lot ${lot}`);
}

// The report is rebuilt from the run history, so it is the same whether the
// drill ran straight through or was resumed in another process.
function report(run: MarkovianRun, meta: DrillMeta, opts: Pick<DrillOptions, "trace" | "agent">): DrillReport {
  const chunks: DrillChunkTelemetry[] = [];
  const gaps: DrillGap[] = [];
  let counters: { cursor: number; traced: number; bySupplier: DrillState["bySupplier"] } = { cursor: 0, traced: 0, bySupplier: {} };
  for (const c of run.chunks) {
    const lines = c.content.split("\n");
    const found = lines.filter((l) => l.startsWith("GAP ")).map((l) => JSON.parse(l.slice(4)) as DrillGap);
    const line = lines.find((l) => l.startsWith("COUNTERS "));
    const prevCursor = counters.cursor;
    if (line) counters = JSON.parse(line.slice("COUNTERS ".length));
    gaps.push(...found);
    chunks.push({
      chunk: c.step,
      lots: counters.cursor - prevCursor,
      firstLot: meta.lots[prevCursor],
      lastLot: meta.lots[counters.cursor - 1],
      cursor: counters.cursor,
      carryoverInChars: c.carryoverIn.length,
      carryoverInTokens: estimateTokens(c.carryoverIn),
      carryoverOutChars: c.carryoverOut.length,
      carryoverOutTokens: estimateTokens(c.carryoverOut),
      outputTokens: c.tokens,
      cascadeLevel: c.cascadeLevel,
      newGaps: found.length,
      final: c.markers.final,
    });
  }
  const carried = chunks.filter((c) => !c.final).map((c) => c.carryoverOutTokens);
  const out: DrillReport = {
    runId: run.id,
    status: run.status,
    lotsTotal: meta.lots.length,
    lotsProcessed: counters.cursor,
    traced: counters.traced,
    gaps,
    bySupplier: counters.bySupplier,
    state: { traced: counters.traced, gaps: gaps.slice(-meta.keepRecentGaps), bySupplier: counters.bySupplier },
    chunks,
    carryoverBudgetTokens: run.chunkConfig.carryoverTokens,
    maxCarryoverTokens: carried.length ? Math.max(...carried) : 0,
    tokens: { used: run.totalTokensUsed, saved: run.totalTokensSaved, efficiencyPercent: run.efficiencyPercent, label: run.tokenLabel },
    resumed: run.resumes.length,
    ...(run.error ? { error: run.error } : {}),
  };
  opts.trace?.emit({
    agent_name: opts.agent ?? "markovian",
    action: "markovian.drill",
    input_summary: `${meta.lots.length} lots, ${meta.chunkSize} per chunk`,
    output_summary: `${out.status}: ${out.traced} traced, ${out.gaps.length} gaps, ${out.chunks.length} chunks`,
    status: out.status === "completed" ? "success" : "error",
    detail: { runId: out.runId, maxCarryoverTokens: out.maxCarryoverTokens, resumed: out.resumed, tokens: out.tokens },
  });
  return out;
}
