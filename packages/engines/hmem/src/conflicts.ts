// Contradiction detection and resolution. Detection looks for opposing phrase
// pairs, one-sided negation and divergent numbers on similar content, and for
// structured claims about the same subject with different values. Conflicts
// are persisted as records; resolution happens on the record (status,
// strategy, winner, decision confidence) and on the loser (supersededBy). A
// resolution never deletes a record unless a reviewer explicitly asks for
// "delete_both".

import path from "node:path";
import { appendJsonl, readJsonl } from "./jsonl.ts";
import type { TrustLedger } from "./ledger.ts";
import type { MemoryStore } from "./store.ts";
import { cosine } from "./text.ts";
import type { ConflictKind, ConflictRecord, Memory, ResolutionStrategy } from "./types.ts";
import { DAY_MS, DEFAULTS, clamp01 } from "./types.ts";

const OPPOSING: [RegExp, RegExp][] = [
  [/\balways\b/i, /\bnever\b/i],
  [/\benabled?\b|\benables\b/i, /\bdisabled?\b|\bdisables\b/i],
  [/\bbefore\b/i, /\bafter\b/i],
  [/\ballow(s|ed)?\b/i, /\b(deny|denies|denied|forbid(s|den)?)\b/i],
  [/\binclude[sd]?\b/i, /\bexclude[sd]?\b/i],
  [/\bwith\b/i, /\bwithout\b/i],
  [/\brequired\b/i, /\boptional\b/i],
  [/\btrue\b/i, /\bfalse\b/i],
  [/\bprefers?\b/i, /\b(avoids?|dislikes?)\b/i],
];
const NEGATION = /\b(no|not|never|none|without|cannot|can't|doesn't|don't|isn't|aren't|won't)\b/i;

const RELIABILITY: Partial<Record<Memory["provenance"]["origin"], number>> = {
  user_explicit: 1,
  decision: 0.8,
  goal_run: 0.7,
  tool: 0.7,
  plan_run: 0.7,
  import: 0.6,
  chat: 0.5,
  web: 0.5,
  inference: 0.4,
};

export interface ResolveOptions {
  actor?: string;
  note?: string;
  /** Content for the merged record when the strategy is "merge". */
  mergedContent?: string;
}

export class ConflictService {
  private readonly records = new Map<string, ConflictRecord>();
  private readonly file?: string;

  constructor(
    private readonly store: MemoryStore,
    private readonly ledger: TrustLedger,
    private readonly clock: () => number,
    private readonly actor: string,
    dir?: string,
  ) {
    if (dir) {
      this.file = path.join(dir, "conflicts.jsonl");
      for (const c of readJsonl<ConflictRecord>(this.file)) this.records.set(c.id, c);
    }
  }

  /** Scan every live pair. Returns the open conflicts found in this pass (new or still open). */
  scan(): ConflictRecord[] {
    const live = this.store.all();
    const found: ConflictRecord[] = [];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const c = this.checkPair(live[i], live[j]);
        if (c) found.push(c);
      }
    }
    return found;
  }

  /** Check one record against `among` (default: every other live record). */
  scanFor(memoryId: string, among?: string[]): ConflictRecord[] {
    const target = this.store.get(memoryId);
    if (!target) throw new Error(`H-MEM: unknown memory id ${memoryId}`);
    const pool = among ? among.map((id) => this.store.get(id)).filter((m): m is Memory => !!m) : this.store.all();
    const found: ConflictRecord[] = [];
    for (const other of pool) {
      if (other.id === memoryId) continue;
      const c = this.checkPair(other, target);
      if (c) found.push(c);
    }
    return found;
  }

  get(id: string): ConflictRecord | undefined {
    return this.records.get(id);
  }

  all(): ConflictRecord[] {
    return [...this.records.values()];
  }

  open(): ConflictRecord[] {
    return this.all().filter((c) => c.status === "open");
  }

  /** The review queue: conflicts the auto-resolver did not settle. */
  queue(): ConflictRecord[] {
    return this.open();
  }

  forMemory(memoryId: string): ConflictRecord[] {
    return this.all().filter((c) => c.memoryA === memoryId || c.memoryB === memoryId);
  }

  hasOpen(memoryId: string): boolean {
    return this.forMemory(memoryId).some((c) => c.status === "open");
  }

  /**
   * Weighted auto-decision over recency, access, confidence, richness and
   * source reliability. Resolves only at decision confidence >= 0.70; anything
   * less stays open for a reviewer.
   */
  autoResolve(conflict: ConflictRecord | string): "resolved" | "queued" {
    const c = this.mustGet(typeof conflict === "string" ? conflict : conflict.id);
    if (c.status === "resolved") return "resolved";
    const a = this.store.get(c.memoryA);
    const b = this.store.get(c.memoryB);
    if (!a || !b) return "queued";
    const sa = this.strength(a);
    const sb = this.strength(b);
    const margin = Math.abs(sa - sb) / Math.max(sa, sb, 1e-9);
    const decisionConfidence = clamp01(0.5 * c.confidence + 0.9 * margin);
    c.decisionConfidence = Number(decisionConfidence.toFixed(3));
    if (decisionConfidence < DEFAULTS.conflictAutoResolveGate) {
      this.persist(c);
      return "queued";
    }
    this.resolve(c.id, sa >= sb ? "keep_a" : "keep_b", { actor: `${this.actor}:auto-resolver` });
    return "resolved";
  }

  /** Apply a resolution strategy on the record. Losers are superseded, not deleted. */
  resolve(conflictId: string, strategy: ResolutionStrategy, opts: ResolveOptions = {}): ConflictRecord {
    const c = this.mustGet(conflictId);
    if (c.status === "resolved") throw new Error(`H-MEM: conflict ${conflictId} is already resolved`);
    const actor = opts.actor ?? this.actor;
    const a = this.store.get(c.memoryA);
    const b = this.store.get(c.memoryB);
    if (!a || !b) throw new Error(`H-MEM: conflict ${conflictId} refers to a missing record`);
    const details = { conflictId, strategy, note: opts.note };

    // One conflict_resolved entry per affected record, carrying previous and new state.
    const supersede = (loser: Memory, winnerId: string) =>
      this.store.update(loser.id, { supersededBy: winnerId }, { action: "conflict_resolved", actor, details: { ...details, winner: winnerId } });

    switch (strategy) {
      case "keep_a":
        supersede(b, a.id);
        c.winner = a.id;
        break;
      case "keep_b":
        supersede(a, b.id);
        c.winner = b.id;
        break;
      case "keep_both":
        // Both stand; linking them marks the pair as reviewed and lowers future false positives.
        for (const [m, other] of [[a, b], [b, a]] as const) {
          if (!m.relatedTo.includes(other.id)) {
            this.store.update(m.id, { relatedTo: [...m.relatedTo, other.id] }, { action: "conflict_resolved", actor, details });
          }
        }
        break;
      case "merge": {
        const merged = this.store.add({
          content: opts.mergedContent ?? `${a.content}; ${b.content}`,
          source: `conflict:${c.id}`,
          type: a.type,
          layer: a.layer === "long_term" || b.layer === "long_term" ? "long_term" : "working",
          tags: [...new Set([...a.tags, ...b.tags])],
          confidence: Math.max(a.confidence, b.confidence),
          domain: a.domain,
          derivedFrom: [a.id, b.id],
          provenance: { origin: "decision", learnedAt: this.clock(), label: `merged while resolving ${c.id}` },
          actor,
        });
        supersede(a, merged.id);
        supersede(b, merged.id);
        c.winner = merged.id;
        break;
      }
      case "delete_both":
        this.store.delete(a.id, { action: "conflict_resolved", actor, details, reason: "reviewer chose delete_both" });
        this.store.delete(b.id, { action: "conflict_resolved", actor, details, reason: "reviewer chose delete_both" });
        break;
      default:
        throw new Error(`H-MEM: unknown resolution strategy ${strategy as string}`);
    }

    c.status = "resolved";
    c.resolution = strategy;
    c.resolvedAt = this.clock();
    c.resolvedBy = actor;
    if (opts.note) c.note = opts.note;
    this.persist(c);
    return c;
  }

  // A pair is checked once: an existing record for the pair is returned while open,
  // and a resolved pair is never re-raised.
  private checkPair(a: Memory, b: Memory): ConflictRecord | undefined {
    const existing = this.all().find(
      (c) => (c.memoryA === a.id && c.memoryB === b.id) || (c.memoryA === b.id && c.memoryB === a.id),
    );
    if (existing) return existing.status === "open" ? existing : undefined;
    const detected = detect(a, b);
    if (!detected) return undefined;
    const c: ConflictRecord = {
      id: `conflict-${this.records.size + 1}`,
      memoryA: a.id,
      memoryB: b.id,
      kind: detected.kind,
      reason: detected.reason,
      confidence: Number(detected.confidence.toFixed(3)),
      status: "open",
      detectedAt: this.clock(),
    };
    this.persist(c);
    for (const [m, other] of [[a, b], [b, a]] as const) {
      this.ledger.log(m.id, "conflict_detected", this.actor, {
        details: { conflictId: c.id, with: other.id, kind: c.kind, reason: c.reason, confidence: c.confidence },
      });
    }
    return c;
  }

  private strength(m: Memory): number {
    const idleDays = Math.max(0, this.clock() - m.lastAccessed) / DAY_MS;
    const reliability = /user_correction/i.test(m.source) ? 1 : (RELIABILITY[m.provenance.origin] ?? 0.5);
    return (
      0.35 * m.confidence +
      0.15 * Math.exp(-idleDays / DEFAULTS.recencyDays) +
      0.15 * Math.min(1, m.accessCount / 10) +
      0.1 * Math.min(1, m.content.length / 200) +
      0.25 * reliability
    );
  }

  private persist(c: ConflictRecord): void {
    this.records.set(c.id, c);
    if (this.file) appendJsonl(this.file, c);
  }

  private mustGet(id: string): ConflictRecord {
    const c = this.records.get(id);
    if (!c) throw new Error(`H-MEM: unknown conflict ${id}`);
    return c;
  }
}

/** Contradiction heuristics on one pair. Returns the strongest signal, if any. */
export function detect(a: Memory, b: Memory): { kind: ConflictKind; reason: string; confidence: number } | undefined {
  // A supersedes edge is an intended replacement, not a contradiction.
  if (a.supersedes === b.id || b.supersedes === a.id || a.supersededBy === b.id || b.supersededBy === a.id) return undefined;

  const signals: { kind: ConflictKind; reason: string; confidence: number }[] = [];
  if (a.claim && b.claim && a.claim.subject === b.claim.subject && a.claim.value !== b.claim.value) {
    signals.push({
      kind: "same-subject",
      reason: `same subject "${a.claim.subject}", divergent claims (${a.claim.value} vs ${b.claim.value})`,
      confidence: 0.85,
    });
  }

  const sim = cosine(a.embedding ?? [], b.embedding ?? []);
  const shared = a.entities.some((e) => b.entities.some((f) => f.name === e.name));
  const oneSided = (p: RegExp, q: RegExp) =>
    (p.test(a.content) && q.test(b.content) && !q.test(a.content)) || (q.test(a.content) && p.test(b.content) && !p.test(a.content));

  if (sim >= 0.5 && OPPOSING.some(([p, q]) => oneSided(p, q))) {
    signals.push({ kind: "opposing-phrase", reason: "opposing phrase pair on similar content", confidence: 0.5 + 0.3 * sim });
  }
  if (NEGATION.test(a.content) !== NEGATION.test(b.content) && (sim >= 0.75 || (sim >= 0.55 && shared))) {
    signals.push({ kind: "negation", reason: "one-sided negation on similar content", confidence: 0.45 + 0.3 * sim });
  }
  if (sim >= 0.8) {
    const nums = (m: Memory) => (m.content.match(/\d+(?:\.\d+)?/g) ?? []).join(",");
    if (nums(a) && nums(b) && nums(a) !== nums(b)) {
      signals.push({ kind: "numeric", reason: "high-similarity claims with divergent numbers", confidence: 0.55 + 0.25 * sim });
    }
  }
  if (signals.length === 0) return undefined;
  const best = signals.reduce((x, y) => (y.confidence > x.confidence ? y : x));

  // Confidence modifiers: shared entities and domain raise it, an explicit relation lowers it.
  let confidence = best.confidence;
  if (shared) confidence += 0.1;
  if (a.domain === b.domain) confidence += 0.05;
  if (a.relatedTo.includes(b.id) || b.relatedTo.includes(a.id)) confidence -= 0.1;
  return { ...best, confidence: clamp01(confidence) };
}
