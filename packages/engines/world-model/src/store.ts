// The canonical store is an append-only event log, held in memory or in a
// JSONL file (one event per line). Current state is a Projection: a fold over
// the log in seq order. Nothing in the projection is ever written directly, so
// replaying the same log always rebuilds the same state.

import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./ids.ts";
import type {
  Entity, EntityPayload, EventKind, EventPayloads, MergeProposal, ObservationRecord,
  Relationship, RelationPayload, StoredProvenance, WorldEvent, WorldShape,
} from "./types.ts";

export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ event log

export interface EventMeta {
  at: string;
  recordedAt: string;
  actor: string;
  runId?: string;
}

export class EventLog {
  private readonly list: WorldEvent[] = [];
  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
    if (file) {
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      this.list.push(...loadJsonl(file));
    }
  }

  get seq(): number {
    return this.list.length === 0 ? 0 : this.list[this.list.length - 1].seq;
  }

  get events(): readonly WorldEvent[] {
    return this.list;
  }

  /** Durable first: the event reaches the file before it is visible in memory. */
  append<K extends EventKind>(kind: K, payload: EventPayloads[K], meta: EventMeta): WorldEvent {
    const seq = this.seq + 1;
    const event = { v: 1, seq, id: `evt_${seq}`, kind, ...meta, payload } as WorldEvent;
    if (this.file) appendFileSync(this.file, JSON.stringify(event) + "\n", "utf8");
    this.list.push(event);
    return event;
  }
}

/**
 * Reads a JSONL event log. A torn final line (the process died mid-append) is
 * cut off so the next append starts clean; damage anywhere else is fatal,
 * because silently skipping an event would rebuild a different world.
 */
function loadJsonl(file: string): WorldEvent[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const events: WorldEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.trim() === "") continue;
    const isLast = i === lines.length - 1; // only set when the file lacks a trailing newline
    let event: WorldEvent;
    try {
      event = JSON.parse(line) as WorldEvent;
    } catch {
      if (!isLast) throw new Error(`World Model: event log ${file} is corrupt at line ${i + 1}`);
      truncateSync(file, Buffer.byteLength(lines.slice(0, i).map((l) => `${l}\n`).join(""), "utf8"));
      break;
    }
    const expected = events.length + 1;
    if (event.v !== 1 || event.seq !== expected) {
      throw new Error(`World Model: event log ${file} is corrupt at line ${i + 1} (expected seq ${expected}, schema v1)`);
    }
    events.push(event);
    if (isLast) appendFileSync(file, "\n", "utf8");
  }
  return events;
}

// ------------------------------------------------------------------ reducers

const later = (a: string, b: string): string => (a > b ? a : b);

/** Fold one entity write onto the current record: latest name wins, attrs merge, names accumulate. */
export function nextEntity(prev: Entity | undefined, p: EntityPayload): Entity {
  const aliases = prev ? [...prev.aliases] : [];
  if (p.name && !aliases.includes(p.name)) aliases.push(p.name);
  return {
    id: p.id,
    type: p.type,
    name: p.name ?? prev?.name,
    aliases,
    attrs: { ...prev?.attrs, ...p.attrs },
    // an explicit upsert promotes an endpoint-only ("emerging") node to a known entity
    state: p.state ?? (prev && prev.state !== "emerging" ? prev.state : "active"),
    source: p.source,
    createdAt: prev?.createdAt ?? p.source.at,
    updatedAt: prev ? later(prev.updatedAt, p.source.at) : p.source.at,
  };
}

/** Fold one edge write onto the current record. Identity fields never change (they are the id). */
export function nextRelation(prev: Relationship | undefined, p: RelationPayload): Relationship {
  if (!prev) {
    const { validTo, ...rest } = p;
    return { ...rest, attrs: { ...p.attrs }, ...(validTo ? { validTo } : {}), createdAt: p.source.at, updatedAt: p.source.at };
  }
  const next: Relationship = {
    ...prev,
    attrs: { ...prev.attrs, ...p.attrs },
    cardinality: p.cardinality,
    source: p.source,
    updatedAt: later(prev.updatedAt, p.source.at),
  };
  if (p.validTo) {
    next.validTo = p.validTo;
    delete next.supersededBy;
  }
  return next;
}

const entityContent = (e: Entity) => ({ type: e.type, name: e.name, aliases: e.aliases, attrs: e.attrs, state: e.state });
const relationContent = (r: Relationship) => ({ attrs: r.attrs, cardinality: r.cardinality, validTo: r.validTo, supersededBy: r.supersededBy });

/**
 * Would this write change what the world says? Provenance alone does not
 * count: re-observing the same fact through a different query is
 * corroboration, so it appends nothing and keeps re-runs idempotent.
 */
export function entityChanges(prev: Entity, p: EntityPayload): boolean {
  return canonicalJson(entityContent(nextEntity(prev, p))) !== canonicalJson(entityContent(prev));
}

export function relationChanges(prev: Relationship, p: RelationPayload): boolean {
  return canonicalJson(relationContent(nextRelation(prev, p))) !== canonicalJson(relationContent(prev));
}

/** Entity type of an endpoint we only know by id: `lot:PK123` -> "lot". */
function typeOfId(id: string): string {
  const colon = id.indexOf(":");
  return colon > 0 && !id.startsWith("ent_") ? id.slice(0, colon) : "entity";
}

// ------------------------------------------------------------------ projection

export class Projection {
  readonly entities = new Map<string, Entity>();
  readonly relations = new Map<string, Relationship>();
  readonly aliases = new Map<string, string>();
  readonly observations = new Map<string, ObservationRecord>();
  readonly proposals = new Map<string, MergeProposal>();
  // adjacency indexes: node id -> ids of edges leaving / entering it
  private readonly outIndex = new Map<string, Set<string>>();
  private readonly inIndex = new Map<string, Set<string>>();

  apply(event: WorldEvent): void {
    switch (event.kind) {
      case "entity.upserted":
        this.entities.set(event.payload.id, nextEntity(this.entities.get(event.payload.id), event.payload));
        break;
      case "entity.aliased":
        this.aliases.set(event.payload.aliasId, event.payload.primaryId);
        break;
      case "merge.proposed":
        this.proposals.set(event.payload.id, { ...event.payload });
        break;
      case "relation.asserted":
        this.applyRelation(event.payload);
        break;
      case "observation.recorded":
        this.observations.set(event.payload.externalId, { ...event.payload, mentions: [...event.payload.mentions] });
        break;
      default: {
        const unknown: never = event;
        throw new Error(`World Model: unknown event kind ${(unknown as { kind: string }).kind}`);
      }
    }
  }

  /** Follows merge aliases to the surviving id. */
  resolve(id: string): string {
    let current = id;
    const seen = new Set<string>();
    while (this.aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.aliases.get(current)!;
    }
    return current;
  }

  /** Live edge records touching a node (callers must not mutate them). */
  edgesOf(id: string, direction: "out" | "in"): Relationship[] {
    const ids = (direction === "out" ? this.outIndex : this.inIndex).get(id) ?? new Set<string>();
    return [...ids].map((rid) => this.relations.get(rid)!);
  }

  shape(): WorldShape {
    const byId = <T extends { id: string }>(items: Iterable<T>) => [...items].sort((a, b) => compare(a.id, b.id));
    return {
      entities: byId(this.entities.values()),
      relationships: byId(this.relations.values()),
      aliases: [...this.aliases.entries()].sort((a, b) => compare(a[0], b[0])),
      observations: [...this.observations.values()].sort((a, b) => compare(a.externalId, b.externalId)),
      mergeProposals: byId(this.proposals.values()),
    };
  }

  private applyRelation(p: RelationPayload): void {
    const prev = this.relations.get(p.id);
    const rel = nextRelation(prev, p);
    this.relations.set(rel.id, rel);
    if (!prev) {
      index(this.outIndex, rel.from, rel.id);
      index(this.inIndex, rel.to, rel.id);
      this.materialize(rel.from, p.source);
      this.materialize(rel.to, p.source);
    }
    if (rel.cardinality === "many" && rel.supersededBy) {
      delete rel.validTo;
      delete rel.supersededBy;
    }
    if (rel.cardinality === "one" || prev?.cardinality === "one") this.rechain(rel.from, rel.type, rel.context);
  }

  /** An edge never dangles: unknown endpoints appear as "emerging" entities. */
  private materialize(id: string, source: StoredProvenance): void {
    if (this.entities.has(id)) return;
    this.entities.set(id, {
      id, type: typeOfId(id), aliases: [], attrs: {}, state: "emerging",
      source, createdAt: source.at, updatedAt: source.at,
    });
  }

  /**
   * Cardinality "one": open edges with the same (from, type, context) form a
   * chain ordered by validFrom, and each edge is valid until its successor
   * starts. Recomputing the chain (instead of closing "the previous" edge)
   * keeps history right when records arrive out of order. Ties go to the
   * later write. Edges the writer closed explicitly stay as written.
   */
  private rechain(from: string, type: string, context: string | undefined): void {
    const chain = this.edgesOf(from, "out")
      .filter((r) => r.type === type && (r.context ?? "") === (context ?? "") && r.cardinality === "one")
      .filter((r) => !(r.validTo !== undefined && r.supersededBy === undefined))
      .sort((a, b) => compare(a.validFrom, b.validFrom));
    for (const r of chain) {
      delete r.validTo;
      delete r.supersededBy;
    }
    for (let i = 0; i + 1 < chain.length; i++) {
      chain[i].validTo = chain[i + 1].validFrom;
      chain[i].supersededBy = chain[i + 1].id;
    }
  }
}

function index(map: Map<string, Set<string>>, node: string, relId: string): void {
  let set = map.get(node);
  if (!set) map.set(node, (set = new Set()));
  set.add(relId);
}
