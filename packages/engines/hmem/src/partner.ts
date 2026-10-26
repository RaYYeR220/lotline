// Lotline partner memory on top of H-MEM: source quirks (how a partner system
// actually formats its data) and prior rulings on trace links. Both persist
// across runs, carry provenance back to the run that produced them, and go
// through conflict detection so a contradicting observation is recorded as a
// conflict rather than quietly replacing what was learned before.

import type { TraceLog } from "@lotline/core";
import type { HMEM } from "./hmem.ts";
import { normalizeContent } from "./text.ts";
import type { Memory } from "./types.ts";

export const QUIRK_TAG = "lotline:quirk";
export const RULING_TAG = "lotline:ruling";

/** Re-observing a known quirk or ruling raises confidence by this much, up to the cap. */
const REINFORCE = 0.05;
const REINFORCE_CAP = 0.95;

export type Ruling = "proven" | "unproven" | "rejected";
const RULINGS: readonly Ruling[] = ["proven", "unproven", "rejected"];

export interface PartnerWriteOptions {
  actor?: string;
}

export interface RecallOptions {
  /** When given, the recall is written to the run trace as action "hmem.recall". */
  trace?: Pick<TraceLog, "emit">;
  /** Agent recorded in the trace and as the ledger actor of the reads. */
  agent?: string;
  topN?: number;
  /** Also return records that lost a conflict (default false). */
  includeSuperseded?: boolean;
}

export interface RecalledQuirk {
  text: string;
  confidence: number;
  /** Ledger entry that recorded how this quirk was learned. */
  ledgerRef: string;
  memoryId: string;
  /** True while an open conflict involves this quirk. */
  contested: boolean;
  superseded: boolean;
  learnedInRun?: string;
}

export interface RecalledRuling {
  ruling: Ruling;
  reason: string;
  runId?: string;
  confidence: number;
  ledgerRef: string;
  memoryId: string;
  contested: boolean;
  superseded: boolean;
}

export async function rememberQuirk(
  m: HMEM,
  q: { source: string; quirk: string; evidenceRunId: string; confidence?: number },
  opts: PartnerWriteOptions = {},
): Promise<string> {
  requireText(q.source, "source");
  requireText(q.quirk, "quirk");
  requireText(q.evidenceRunId, "evidenceRunId");
  const actor = opts.actor ?? m.actor;
  const peers = quirksOf(m, q.source);

  const same = peers.find((r) => normalizeContent(r.content) === normalizeContent(q.quirk));
  if (same) return reinforce(m, same, actor, { evidenceRunId: q.evidenceRunId });

  const rec = m.add({
    content: q.quirk.trim(),
    source: `run:${q.evidenceRunId}`,
    type: "factual",
    layer: "working",
    tags: [QUIRK_TAG, `source:${q.source}`],
    confidence: q.confidence ?? 0.7,
    domain: "partner-data",
    namespace: `partner-data/quirks/${q.source}`,
    provenance: {
      origin: "goal_run",
      learnedAt: m.clock(),
      label: `observed in ${q.source} during run ${q.evidenceRunId}`,
      refs: { goalRunId: q.evidenceRunId, importSource: q.source },
    },
    actor,
  });
  checkConflicts(m, rec.id, peers);
  return rec.id;
}

export async function recallQuirks(m: HMEM, source: string, opts: RecallOptions = {}): Promise<RecalledQuirk[]> {
  requireText(source, "source");
  const res = m.query(`${source} partner data quirks`, {
    tags: [QUIRK_TAG, `source:${source}`],
    threshold: 0,
    topN: opts.topN ?? 20,
    excludeSuperseded: !opts.includeSuperseded,
    actor: opts.agent,
  });
  const quirks = res.memories.map(({ memory }) => ({
    text: memory.content,
    confidence: memory.confidence,
    ledgerRef: createdRef(m, memory.id),
    memoryId: memory.id,
    contested: m.conflicts.hasOpen(memory.id),
    superseded: memory.supersededBy !== undefined,
    learnedInRun: memory.provenance.refs?.goalRunId,
  }));
  if (opts.trace) {
    const contested = quirks.filter((x) => x.contested).length;
    opts.trace.emit({
      agent_name: opts.agent ?? "hmem",
      action: "hmem.recall",
      input_summary: `partner quirks for ${source}`,
      output_summary: `${quirks.length} quirk(s)${contested ? `, ${contested} contested` : ""}`,
      status: "success",
      confidence: quirks.length ? Math.max(...quirks.map((x) => x.confidence)) : null,
      detail: {
        source,
        memoryIds: quirks.map((x) => x.memoryId),
        ledgerRefs: quirks.map((x) => x.ledgerRef),
        contested,
        weights: res.trace.weights,
      },
    });
  }
  return quirks;
}

export async function rememberRuling(
  m: HMEM,
  r: { linkKey: string; ruling: Ruling; reason: string; runId: string; confidence?: number },
  opts: PartnerWriteOptions = {},
): Promise<string> {
  requireText(r.linkKey, "linkKey");
  requireText(r.reason, "reason");
  requireText(r.runId, "runId");
  if (!RULINGS.includes(r.ruling)) throw new Error(`H-MEM: ruling must be one of ${RULINGS.join(", ")}`);
  const actor = opts.actor ?? m.actor;
  const peers = rulingsOf(m, r.linkKey);

  const same = peers.find((p) => p.claim?.value === r.ruling);
  if (same) return reinforce(m, same, actor, { runId: r.runId, reason: r.reason });

  const rec = m.add({
    content: `${rulingPrefix(r.linkKey, r.ruling)}${r.reason.trim()}`,
    source: `run:${r.runId}`,
    type: "factual",
    layer: "working",
    tags: [RULING_TAG, `link:${r.linkKey}`, `ruling:${r.ruling}`],
    confidence: r.confidence ?? 0.7,
    domain: "trace",
    namespace: "trace/rulings",
    claim: { subject: `link:${r.linkKey}`, value: r.ruling },
    provenance: {
      origin: "decision",
      learnedAt: m.clock(),
      label: `link ruled ${r.ruling} in run ${r.runId}`,
      refs: { goalRunId: r.runId, decisionId: r.linkKey },
    },
    actor,
  });
  checkConflicts(m, rec.id, peers);
  return rec.id;
}

export async function recallRulings(m: HMEM, linkKey: string, opts: RecallOptions = {}): Promise<RecalledRuling[]> {
  requireText(linkKey, "linkKey");
  const res = m.query(linkKey, {
    tags: [RULING_TAG, `link:${linkKey}`],
    threshold: 0,
    topN: opts.topN ?? 50,
    excludeSuperseded: !opts.includeSuperseded,
    actor: opts.agent,
  });
  const rulings = res.memories.map(({ memory }) => {
    const ruling = memory.claim!.value as Ruling;
    return {
      ruling,
      reason: memory.content.slice(rulingPrefix(linkKey, ruling).length),
      runId: memory.provenance.refs?.goalRunId,
      confidence: memory.confidence,
      ledgerRef: createdRef(m, memory.id),
      memoryId: memory.id,
      contested: m.conflicts.hasOpen(memory.id),
      superseded: memory.supersededBy !== undefined,
    };
  });
  opts.trace?.emit({
    agent_name: opts.agent ?? "hmem",
    action: "hmem.recall",
    input_summary: `prior rulings for ${linkKey}`,
    output_summary: rulings.length ? rulings.map((x) => x.ruling).join(", ") : "no prior ruling",
    status: "success",
    confidence: rulings.length ? Math.max(...rulings.map((x) => x.confidence)) : null,
    detail: { linkKey, memoryIds: rulings.map((x) => x.memoryId), ledgerRefs: rulings.map((x) => x.ledgerRef) },
  });
  return rulings;
}

const rulingPrefix = (linkKey: string, ruling: Ruling) => `Link ${linkKey} ruled ${ruling}: `;

function quirksOf(m: HMEM, source: string): Memory[] {
  return m.store.all().filter((r) => r.tags.includes(QUIRK_TAG) && r.tags.includes(`source:${source}`) && !r.supersededBy);
}

function rulingsOf(m: HMEM, linkKey: string): Memory[] {
  return m.store.all().filter((r) => r.tags.includes(RULING_TAG) && r.tags.includes(`link:${linkKey}`) && !r.supersededBy);
}

// A repeat observation strengthens the existing record and is audited with the run that saw it.
function reinforce(m: HMEM, rec: Memory, actor: string, details: Record<string, unknown>): string {
  m.store.update(rec.id, { confidence: Math.max(rec.confidence, Math.min(REINFORCE_CAP, rec.confidence + REINFORCE)) }, {
    actor,
    details: { reason: "re-observed", ...details },
  });
  return rec.id;
}

// New record vs. its peers: every contradiction becomes a conflict record; the
// auto-resolver settles only clear cases and leaves the rest open for review.
function checkConflicts(m: HMEM, id: string, peers: Memory[]): void {
  for (const c of m.conflicts.scanFor(id, peers.map((p) => p.id))) m.conflicts.autoResolve(c);
}

function createdRef(m: HMEM, memoryId: string): string {
  const entry = m.ledger.history(memoryId).find((e) => e.action === "create");
  if (!entry) throw new Error(`H-MEM: no create entry in the ledger for ${memoryId}`);
  return entry.id;
}

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`H-MEM: ${field} is required`);
}
