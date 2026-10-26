// Tiered memory store. Short-term records live only in this process; working
// and long-term records are persisted to <dir>/memories.jsonl as an
// append-only op log (put/del) that is replayed and compacted on load.
// Enrichment runs on every add: domain, namespace, entities, related links
// and correction-driven supersession. Every mutation goes through the ledger.

import path from "node:path";
import { readJsonl, appendJsonl, writeJsonlAtomic } from "./jsonl.ts";
import type { TrustLedger } from "./ledger.ts";
import { classifyDomain, cosine, extractEntities, namespaceFor } from "./text.ts";
import type {
  AddInput, Embedder, LedgerAction, LedgerEntry, Memory, MemoryLayer, MemoryOrigin, MemoryProvenance,
  MemorySnapshot, MemoryType,
} from "./types.ts";
import { DEFAULTS, clamp01 } from "./types.ts";

type StoreOp = { op: "put"; record: Memory } | { op: "del"; id: string };

const TYPES: readonly MemoryType[] = ["personal", "factual", "preference", "general"];
const LAYERS: readonly MemoryLayer[] = ["short_term", "working", "long_term"];
const CORRECTION = /\b(actually|instead|no longer|not anymore|changed to|correction|now uses)\b/i;

/** A ledger-safe copy of a record: no embedding, no runtime score. */
export function snapshot(m: Memory): MemorySnapshot {
  const { embedding: _e, score: _s, ...rest } = m;
  return structuredClone(rest);
}

export interface MutationOptions {
  actor?: string;
  action?: LedgerAction;
  details?: Record<string, unknown>;
}

export class MemoryStore {
  private records = new Map<string, Memory>();
  private seq = 0;
  private readonly file?: string;

  constructor(
    private readonly clock: () => number,
    private readonly ledger: TrustLedger,
    private readonly embedder: Embedder,
    private readonly actor: string,
    dir?: string,
  ) {
    if (dir) {
      this.file = path.join(dir, "memories.jsonl");
      this.load();
    }
  }

  add(input: AddInput): Memory {
    if (typeof input.content !== "string" || input.content.trim() === "") {
      throw new Error("H-MEM: a memory record needs non-empty content");
    }
    if (typeof input.source !== "string" || input.source.trim() === "") {
      throw new Error("H-MEM: a memory record with no source is rejected by construction");
    }
    const confidence = input.confidence ?? DEFAULTS.defaultConfidence;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`H-MEM: confidence must be within [0, 1], got ${confidence}`);
    }
    const type = input.type ?? "general";
    const layer = input.layer ?? "working";
    if (!TYPES.includes(type)) throw new Error(`H-MEM: unknown memory type ${type}`);
    if (!LAYERS.includes(layer)) throw new Error(`H-MEM: unknown memory layer ${layer}`);

    const now = this.clock();
    const tags = [...new Set(input.tags ?? [])];
    const domain = input.domain ?? classifyDomain(input.content, tags, type);
    const record: Memory = {
      id: `mem-${++this.seq}`,
      content: input.content,
      type,
      layer,
      timestamp: now,
      lastAccessed: now,
      accessCount: 0,
      tags,
      domain,
      namespace: input.namespace ?? namespaceFor(domain, type),
      embedding: this.embedder.embed(input.content),
      confidence,
      source: input.source,
      provenance: input.provenance ?? deriveProvenance(input, now),
      chatId: input.chatId,
      missionId: input.missionId,
      goalRunId: input.goalRunId,
      entities: extractEntities(input.content),
      relatedTo: [],
      supersedes: input.supersedes,
      derivedFrom: [...(input.derivedFrom ?? [])],
      claim: input.claim,
    };
    const actor = input.actor ?? this.actor;

    // Enrichment is decided before the create entry so that entry carries the
    // record's links; the back-links on other records are logged as updates.
    const plan = this.planRelationships(record);
    record.relatedTo = plan.relatedTo;
    record.supersedes ??= plan.supersedes;
    this.records.set(record.id, record);
    this.ledger.log(record.id, "create", actor, { newState: snapshot(record) });
    this.save(record);

    for (const otherId of plan.backlinks) {
      const other = this.mustGet(otherId);
      this.update(otherId, { relatedTo: [...other.relatedTo, record.id] }, { actor, details: { linkedTo: record.id } });
    }
    if (record.supersedes && this.records.has(record.supersedes)) {
      this.update(record.supersedes, { supersededBy: record.id }, {
        actor,
        details: { supersededBy: record.id, reason: input.supersedes ? "explicit replacement" : "correction" },
      });
    }
    return record;
  }

  get(id: string): Memory | undefined {
    return this.records.get(id);
  }

  /** Live records in insertion order. Callers may read them; mutate through the store. */
  all(): Memory[] {
    return [...this.records.values()];
  }

  update(id: string, patch: Partial<Memory>, opts: MutationOptions = {}): Memory {
    const rec = this.mustGet(id);
    const prev = snapshot(rec);
    Object.assign(rec, patch);
    if (patch.content !== undefined) {
      rec.embedding = this.embedder.embed(rec.content);
      rec.entities = extractEntities(rec.content);
    }
    this.ledger.log(id, opts.action ?? "update", opts.actor ?? this.actor, {
      previousState: prev,
      newState: snapshot(rec),
      details: opts.details,
    });
    this.save(rec);
    return rec;
  }

  /** Mark `oldId` as replaced by `newId`. The old record is kept and ranked down, never deleted. */
  supersede(oldId: string, newId: string, opts: MutationOptions & { reason?: string } = {}): LedgerEntry {
    this.mustGet(newId);
    const old = this.update(oldId, { supersededBy: newId }, {
      ...opts,
      details: { ...opts.details, supersededBy: newId, reason: opts.reason },
    });
    const replacement = this.mustGet(newId);
    if (!replacement.supersedes) this.update(newId, { supersedes: oldId }, { actor: opts.actor, details: { supersedes: oldId } });
    return this.ledger.history(old.id).at(-1)!;
  }

  delete(id: string, opts: MutationOptions & { reason?: string } = {}): void {
    const rec = this.mustGet(id);
    // The ledger entry is written before the record disappears.
    this.ledger.log(id, opts.action ?? "delete", opts.actor ?? this.actor, {
      previousState: snapshot(rec),
      details: { ...opts.details, reason: opts.reason },
    });
    this.records.delete(id);
    if (this.file) appendJsonl(this.file, { op: "del", id } satisfies StoreOp);
  }

  /** Record an access (retrieval logs the matching "read" entry). */
  touch(id: string): void {
    const rec = this.mustGet(id);
    rec.lastAccessed = this.clock();
    rec.accessCount += 1;
    this.save(rec);
  }

  /** Persist the current state of a record (working and long-term tiers only). */
  save(rec: Memory): void {
    if (!this.file) return;
    if (rec.layer === "short_term") {
      appendJsonl(this.file, { op: "del", id: rec.id } satisfies StoreOp);
      return;
    }
    appendJsonl(this.file, { op: "put", record: snapshot(rec) as Memory } satisfies StoreOp);
  }

  snapshotAll(): { seq: number; records: MemorySnapshot[] } {
    return { seq: this.seq, records: this.all().map(snapshot) };
  }

  /** Replace every record with a backup snapshot. Ids are never reused afterwards. */
  restoreAll(backup: { seq: number; records: MemorySnapshot[] }): void {
    this.records = new Map();
    for (const r of backup.records) this.records.set(r.id!, this.hydrate(structuredClone(r) as Memory));
    this.seq = Math.max(this.seq, backup.seq);
    if (this.file) {
      writeJsonlAtomic(this.file, this.all().filter((r) => r.layer !== "short_term").map((r) => ({ op: "put", record: snapshot(r) })));
    }
  }

  private mustGet(id: string): Memory {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`H-MEM: unknown memory id ${id}`);
    return rec;
  }

  // Replay the op log, backfill embeddings, and compact when the log is mostly history.
  private load(): void {
    const ops = readJsonl<StoreOp>(this.file!);
    for (const op of ops) {
      if (op.op === "put") this.records.set(op.record.id, op.record);
      else this.records.delete(op.id);
    }
    for (const [id, rec] of this.records) this.records.set(id, this.hydrate(rec));
    // Ids also appear in the ledger (short-term records are never persisted), so
    // take the highest id seen anywhere to avoid ever reusing one.
    const ids = [...ops.map((o) => (o.op === "put" ? o.record.id : o.id)), ...this.ledger.all().map((e) => e.memoryId)];
    for (const id of ids) {
      const n = /^mem-(\d+)$/.exec(id)?.[1];
      if (n) this.seq = Math.max(this.seq, Number(n));
    }
    if (ops.length > 2 * this.records.size + 64) {
      writeJsonlAtomic(this.file!, this.all().map((r) => ({ op: "put", record: snapshot(r) })));
    }
  }

  // Migration-safe hydration: fill fields older rows may lack and recompute embeddings.
  private hydrate(rec: Memory): Memory {
    rec.tags ??= [];
    rec.entities ??= [];
    rec.relatedTo ??= [];
    rec.derivedFrom ??= [];
    rec.domain ??= classifyDomain(rec.content, rec.tags, rec.type);
    rec.namespace ??= namespaceFor(rec.domain, rec.type);
    rec.provenance ??= deriveProvenance({ content: rec.content, source: rec.source }, rec.timestamp);
    rec.confidence = clamp01(rec.confidence ?? DEFAULTS.defaultConfidence);
    rec.embedding = this.embedder.embed(rec.content);
    return rec;
  }

  // Related links by shared entity within a domain (bidirectional, capped), and
  // supersession when the new record reads as a correction of a near-duplicate.
  private planRelationships(record: Memory): { relatedTo: string[]; backlinks: string[]; supersedes?: string } {
    const relatedTo: string[] = [];
    const backlinks: string[] = [];
    let supersedes: string | undefined;
    const names = new Set(record.entities.map((e) => e.name));
    for (const other of this.records.values()) {
      if (other.supersededBy) continue;
      const sim = cosine(record.embedding!, other.embedding!);
      if (!record.supersedes && !supersedes && sim > 0.85 && CORRECTION.test(record.content)) {
        supersedes = other.id;
        continue;
      }
      if (relatedTo.length >= DEFAULTS.relatedCap) continue;
      if (other.domain === record.domain && other.entities.some((e) => names.has(e.name))) {
        relatedTo.push(other.id);
        if (other.relatedTo.length < DEFAULTS.relatedCap) backlinks.push(other.id);
      }
    }
    return { relatedTo, backlinks, supersedes };
  }
}

const ORIGIN_BY_PREFIX: [RegExp, MemoryOrigin][] = [
  [/^chat/i, "chat"],
  [/^(run|goal)/i, "goal_run"],
  [/^plan/i, "plan_run"],
  [/^(import|file|document|doc)/i, "import"],
  [/^https?:|^web/i, "web"],
  [/^(user|human|reviewer)/i, "user_explicit"],
  [/^(dream|sleep|inference)/i, "inference"],
  [/^decision/i, "decision"],
  [/^mission/i, "mission"],
];

function deriveProvenance(input: Pick<AddInput, "content" | "source" | "chatId" | "goalRunId">, now: number): MemoryProvenance {
  const origin = ORIGIN_BY_PREFIX.find(([re]) => re.test(input.source))?.[1] ?? "tool";
  const refs: MemoryProvenance["refs"] = {};
  if (input.chatId) refs.chatId = input.chatId;
  if (input.goalRunId) refs.goalRunId = input.goalRunId;
  return {
    origin,
    learnedAt: now,
    label: `${origin.replace("_", " ")} via ${input.source}`,
    ...(Object.keys(refs).length ? { refs } : {}),
  };
}
