// Hybrid retrieval and reinjection. Each candidate is scored with the canonical
// eight-signal blend, clamped, then multiplied by its confidence:
//
//   raw   = 0.35 semantic + 0.20 keyword + 0.10 tag + 0.10 domain
//         + 0.15 entity   + 0.05 layer   + 0.05 recency − 0.20 superseded
//   score = clamp01(raw) × confidence
//
// Superseded records are ranked down, never filtered out by default, so the
// audit trail stays visible; the trace names which ones were suppressed.

import type { TrustLedger } from "./ledger.ts";
import type { MemoryStore } from "./store.ts";
import { classifyDomain, cosine, extractEntities, jaccard, keywords, topKeywords } from "./text.ts";
import type { Embedder, FeedbackKind, Memory } from "./types.ts";
import { DAY_MS, DEFAULTS, FEEDBACK_DELTAS, clamp01 } from "./types.ts";

export const WEIGHTS = {
  semantic: 0.35,
  keyword: 0.2,
  tag: 0.1,
  domain: 0.1,
  entity: 0.15,
  layer: 0.05,
  recency: 0.05,
  superseded: 0.2,
} as const;

/** Persisted with every trace so ranking changes can be tied to a weight profile. */
export const WEIGHT_PROFILE = "weights@2026-10";

const LAYER_WEIGHT: Record<Memory["layer"], number> = { long_term: 1, working: 0.8, short_term: 0.6 };

export interface QueryOptions {
  topN?: number;
  /** Applied to the final score, after the confidence multiplier. */
  threshold?: number;
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  /** Keep records with no scope when a scope is requested (default true). */
  includeUnscoped?: boolean;
  /** Every listed tag must be present on the record. */
  tags?: string[];
  /** Namespace prefix filter. */
  namespace?: string;
  excludeSuperseded?: boolean;
  actor?: string;
}

export interface RankSignals {
  semantic: number;
  keyword: number;
  tag: number;
  domain: number;
  entity: number;
  layer: number;
  recency: number;
  superseded: number;
  raw: number;
}

export interface RankedMemory {
  memory: Memory;
  relevance: number;
  signals: RankSignals;
}

export interface QueryResult {
  memories: RankedMemory[];
  context: string;
  trace: {
    retrievalReason: string;
    strategy: "minimal" | "personal" | "comprehensive";
    weights: string;
    queryDomain: string;
    scores: Record<string, number>;
    /** Superseded records returned alongside their (higher-ranked) replacement. */
    suppressed: string[];
  };
}

interface PreparedQuery {
  embedding: number[];
  tokens: string[];
  entities: string[];
  domain: string;
}

export class RetrievalService {
  constructor(
    private readonly store: MemoryStore,
    private readonly ledger: TrustLedger,
    private readonly embedder: Embedder,
    private readonly clock: () => number,
    private readonly actor: string,
  ) {}

  /** Score one memory against a query without touching or logging anything. */
  explain(memory: Memory, query: string): { score: number; signals: RankSignals } {
    return this.score(memory, this.prepare(query));
  }

  query(text: string, opts: QueryOptions = {}): QueryResult {
    const q = this.prepare(text);
    const threshold = opts.threshold ?? DEFAULTS.retrievalThreshold;
    const topN = opts.topN ?? DEFAULTS.retrievalTopN;

    const ranked: RankedMemory[] = [];
    for (const m of this.store.all()) {
      if (!this.inScope(m, opts)) continue;
      const { score, signals } = this.score(m, q);
      if (score >= threshold) ranked.push({ memory: m, relevance: score, signals });
    }
    ranked.sort((a, b) => b.relevance - a.relevance); // stable: ties keep insertion order
    const top = ranked.slice(0, topN);

    const actor = opts.actor ?? this.actor;
    for (const r of top) {
      r.memory.score = r.relevance;
      this.store.touch(r.memory.id);
      this.ledger.log(r.memory.id, "read", actor, { details: { query: text, relevance: round(r.relevance) } });
    }

    const ids = new Set(top.map((r) => r.memory.id));
    const suppressed = top.filter((r) => r.memory.supersededBy && ids.has(r.memory.supersededBy)).map((r) => r.memory.id);
    const strategy =
      top.length <= 1 ? "minimal"
      : top.some((r) => r.memory.type === "personal" || r.memory.type === "preference") ? "personal"
      : "comprehensive";

    return {
      memories: top,
      context: formatContext(top),
      trace: {
        retrievalReason: `hybrid ranking for "${text}" (query domain: ${q.domain}, ${top.length} of ${ranked.length} above ${threshold})`,
        strategy,
        weights: WEIGHT_PROFILE,
        queryDomain: q.domain,
        scores: Object.fromEntries(top.map((r) => [r.memory.id, round(r.relevance)])),
        suppressed,
      },
    };
  }

  /** Exact feedback deltas: helpful +0.05 (+1 access), not_helpful −0.03, wrong −0.20 (+review tag). */
  feedback(memoryId: string, kind: FeedbackKind, actor = this.actor): void {
    if (!(kind in FEEDBACK_DELTAS)) throw new Error(`H-MEM: unknown feedback kind ${kind}`);
    const m = this.store.get(memoryId);
    if (!m) throw new Error(`H-MEM: unknown memory id ${memoryId}`);
    const delta = FEEDBACK_DELTAS[kind];
    this.store.update(
      memoryId,
      {
        confidence: clamp01(m.confidence + delta),
        accessCount: m.accessCount + (kind === "helpful" ? 1 : 0),
        tags: kind === "wrong" && !m.tags.includes("review") ? [...m.tags, "review"] : m.tags,
      },
      { action: "feedback", actor, details: { kind, delta } },
    );
  }

  private prepare(text: string): PreparedQuery {
    return {
      embedding: this.embedder.embed(text),
      tokens: topKeywords(text, 8),
      entities: extractEntities(text).map((e) => e.name),
      domain: classifyDomain(text),
    };
  }

  private score(m: Memory, q: PreparedQuery): { score: number; signals: RankSignals } {
    const idleDays = Math.max(0, this.clock() - m.lastAccessed) / DAY_MS;
    const signals: RankSignals = {
      semantic: clamp01(cosine(q.embedding, m.embedding ?? this.embedder.embed(m.content))),
      keyword: jaccard(q.tokens, keywords(m.content)),
      tag: jaccard(q.tokens, keywords(m.tags.join(" "))),
      domain: m.domain === q.domain ? 1 : 0,
      entity: jaccard(q.entities, m.entities.map((e) => e.name)),
      layer: LAYER_WEIGHT[m.layer],
      recency: Math.exp(-idleDays / DEFAULTS.recencyDays),
      superseded: m.supersededBy ? 1 : 0,
      raw: 0,
    };
    signals.raw =
      WEIGHTS.semantic * signals.semantic +
      WEIGHTS.keyword * signals.keyword +
      WEIGHTS.tag * signals.tag +
      WEIGHTS.domain * signals.domain +
      WEIGHTS.entity * signals.entity +
      WEIGHTS.layer * signals.layer +
      WEIGHTS.recency * signals.recency -
      WEIGHTS.superseded * signals.superseded;
    return { score: clamp01(signals.raw) * m.confidence, signals };
  }

  private inScope(m: Memory, opts: QueryOptions): boolean {
    const unscoped = opts.includeUnscoped ?? true;
    const fits = (want: string | undefined, have: string | undefined) =>
      want === undefined || have === want || (have === undefined && unscoped);
    if (!fits(opts.chatId, m.chatId) || !fits(opts.missionId, m.missionId) || !fits(opts.goalRunId, m.goalRunId)) return false;
    if (opts.tags && !opts.tags.every((t) => m.tags.includes(t))) return false;
    if (opts.namespace && !m.namespace.startsWith(opts.namespace)) return false;
    if (opts.excludeSuperseded && m.supersededBy) return false;
    return true;
  }
}

/** Domain-grouped reinjection block with layer markers, entities and ids. */
export function formatContext(items: RankedMemory[]): string {
  if (items.length === 0) return "";
  const byDomain = new Map<string, RankedMemory[]>();
  for (const it of items) byDomain.set(it.memory.domain, [...(byDomain.get(it.memory.domain) ?? []), it]);
  const lines = ["[MEMORY CONTEXT]"];
  for (const [domain, list] of [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${domain}`);
    for (const { memory: m } of list) {
      const marker = m.layer === "long_term" ? "LT" : m.layer === "working" ? "WK" : "ST";
      const ents = m.entities.length ? ` (entities: ${m.entities.map((e) => e.name).join(", ")})` : "";
      const flag = m.supersededBy ? ` [superseded by ${m.supersededBy}]` : "";
      lines.push(`- [${marker}] ${m.content}${ents}${flag} <${m.id}, conf ${m.confidence.toFixed(2)}>`);
    }
  }
  lines.push("[/MEMORY CONTEXT]");
  return lines.join("\n");
}

const round = (x: number) => Number(x.toFixed(4));
