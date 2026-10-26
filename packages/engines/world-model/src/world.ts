// WorldModel: the write surface and the entry point to the read views.
//
// Writes are validated, given stable ids, compared with current state and
// only then appended to the event log; a write that would not change what
// the world says appends nothing. Writes run one at a time through a FIFO
// queue, so concurrent callers see a single, ordered history.

import { canonicalJson, entityIdFromName, externalEntityId, relationId, sha256Hex, toIso } from "./ids.ts";
import { batchRunId, checkProvenance, compact, prepareObservation } from "./ingest.ts";
import { decide, nameSimilarity } from "./resolve.ts";
import { EventLog, Projection, compare, entityChanges, relationChanges } from "./store.ts";
import { GraphView } from "./views.ts";
import type {
  AuditEntry, Cardinality, Entity, EntityPayload, EventKind, EventPayloads, IngestObservation, IngestReport,
  MergeProposal, Relationship, RelateInput, RelationPayload, StoredProvenance, UpsertEntityInput, WorldEvent,
  WorldModelOptions, WorldShape,
} from "./types.ts";

export class WorldModel {
  readonly namespace: string;
  private readonly log: EventLog;
  private readonly state = new Projection();
  private readonly clock: () => Date;
  private readonly cardinality: Record<string, Cardinality>;
  private readonly resolver: { enabled: boolean; autoMergeAt?: number; reviewFloor?: number };
  private readonly listeners = new Set<(event: WorldEvent) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  /** run id stamped on events while a batch is being applied */
  private runId: string | undefined;

  constructor(options: WorldModelOptions = {}) {
    const storage = options.storage ?? "memory";
    if (storage !== "memory" && storage !== "file") throw new Error(`World Model: unknown storage "${String(storage)}"`);
    if (storage === "file" && !options.path) throw new Error('World Model: storage "file" needs a path for its event log');
    this.namespace = options.namespace ?? "world";
    this.clock = options.clock ?? (() => new Date());
    this.cardinality = { ...options.cardinality };
    this.resolver = { enabled: true, ...options.resolver };
    this.log = new EventLog(storage === "file" ? options.path : undefined);
    // derived state is never stored: it is rebuilt by replaying the log
    for (const event of this.log.events) this.state.apply(event);
  }

  // ---------------------------------------------------------------- writes

  upsertEntity(input: UpsertEntityInput): Promise<Entity> {
    return this.serialize(() => this.writeEntity(input));
  }

  relate(input: RelateInput): Promise<Relationship> {
    return this.serialize(() => this.writeRelation(this.prepareRelation(input)));
  }

  /**
   * Batch ingest of raw observations. Each observation becomes an entity
   * (`<type>:ingest:<externalId>`) with `mentions` edges to the name-keyed
   * entities it names. An observation whose checksum is already recorded is
   * skipped, so the same batch twice reports `changed: false`.
   */
  ingest(observations: IngestObservation[], options: { runId?: string } = {}): Promise<IngestReport> {
    return this.serialize(() => {
      if (!Array.isArray(observations)) throw new Error("World Model: ingest() takes an array of observations");
      const prepared = observations.map((obs, i) => prepareObservation(obs, i));
      const runId = options.runId ?? batchRunId(prepared.map((p) => p.checksum));
      return this.runBatch(runId, prepared, (obs) => {
        if (this.state.observations.get(obs.externalId)?.checksum === obs.checksum) return;
        const item = this.writeEntity({
          type: obs.type, externalKey: { system: "ingest", id: obs.externalId }, name: obs.title,
          attrs: { title: obs.title, text: obs.text }, source: obs.source,
        });
        const mentions = new Set<string>();
        for (const m of obs.mentions) {
          const entity = this.writeEntity({ type: m.type, name: m.name, source: obs.source });
          mentions.add(entity.id);
          this.writeRelation(this.prepareRelation({ from: item.id, type: "mentions", to: entity.id, cardinality: "many", source: obs.source }));
        }
        this.emit("observation.recorded", {
          externalId: obs.externalId, entityId: item.id, checksum: obs.checksum, at: obs.at, mentions: [...mentions].sort(compare),
        }, obs.at, "ingest");
      });
    });
  }

  /** Batch relate() with an idempotency report. The whole batch is validated before anything is appended. */
  ingestRelations(inputs: RelateInput[], options: { runId?: string } = {}): Promise<IngestReport> {
    return this.serialize(() => {
      if (!Array.isArray(inputs)) throw new Error("World Model: ingestRelations() takes an array");
      const prepared = inputs.map((input) => this.prepareRelation(input));
      const runId = options.runId ?? batchRunId(prepared.map((p) => canonicalJson([p.id, p.attrs, p.cardinality, p.validTo])));
      return this.runBatch(runId, prepared, (p) => this.writeRelation(p));
    });
  }

  // ---------------------------------------------------------------- reads

  view(name: "graph"): GraphView;
  view(name: string): GraphView {
    if (name === "graph") return new GraphView(this.state);
    throw new Error(`World Model: unknown view "${name}"`);
  }

  /** One entry per appended event, in log order (strictly increasing seq). */
  audit(): AuditEntry[] {
    return this.log.events.map((e) => ({
      seq: e.seq, at: e.at, recordedAt: e.recordedAt, kind: e.kind, actor: e.actor,
      summary: summarize(e), eventId: e.id, ...(e.runId ? { runId: e.runId } : {}),
    }));
  }

  events(): WorldEvent[] {
    return structuredClone([...this.log.events]);
  }

  mergeQueue(): MergeProposal[] {
    return this.state.shape().mergeProposals.map((p) => ({ ...p }));
  }

  stateShape(): WorldShape {
    return structuredClone(this.state.shape());
  }

  /** The idempotency diff surface: canonical JSON of everything the log derives. */
  stateShapeCanonical(): string {
    return canonicalJson(this.state.shape());
  }

  /** Called after every appended event, in order. */
  subscribe(listener: (event: WorldEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------------------------------------------------------------- internals

  private serialize<T>(job: () => T): Promise<T> {
    const result = this.queue.then(job);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private emit<K extends EventKind>(kind: K, payload: EventPayloads[K], at: string, actor: string): void {
    const event = this.log.append(kind, payload, {
      at, recordedAt: this.clock().toISOString(), actor, ...(this.runId ? { runId: this.runId } : {}),
    });
    this.state.apply(event);
    // The event is durable at this point: a failing listener is reported, but
    // must not turn a completed write into a rejected promise.
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(event));
      } catch (err) {
        console.error(`World Model: subscriber failed on ${event.id} (${event.kind}):`, err);
      }
    }
  }

  private runBatch<T>(runId: string, items: T[], applyOne: (item: T) => unknown): IngestReport {
    const before = this.stateShapeCanonical();
    const firstSeq = this.log.seq;
    let processed = 0;
    this.runId = runId;
    try {
      for (const item of items) {
        const seq = this.log.seq;
        applyOne(item);
        if (this.log.seq > seq) processed++;
      }
    } finally {
      this.runId = undefined;
    }
    const appended = this.log.seq - firstSeq;
    return { runId, processed, skipped: items.length - processed, appended, changed: appended > 0 && this.stateShapeCanonical() !== before };
  }

  private writeEntity(input: UpsertEntityInput): Entity {
    const source = checkProvenance(input?.source);
    if (typeof input.type !== "string" || input.type === "") throw new Error("World Model: upsertEntity() needs a type");
    const name = input.name ?? (typeof input.attrs?.name === "string" ? input.attrs.name : undefined);
    const nameKeyed = input.id === undefined && input.externalKey === undefined;
    if (nameKeyed && !name) throw new Error("World Model: an entity needs an id, an externalKey or a name");

    const derived = input.id
      ?? (input.externalKey ? externalEntityId(input.type, input.externalKey.system, input.externalKey.id) : entityIdFromName(input.type, name!));
    let id = this.state.resolve(derived);
    if (nameKeyed && !this.state.entities.has(id)) id = this.resolveName(id, input.type, name!, source);

    const payload: EntityPayload = {
      id, type: input.type, ...(name ? { name } : {}), attrs: compact(input.attrs),
      ...(input.state ? { state: input.state } : {}), source,
    };
    const prev = this.state.entities.get(id);
    if (!prev || entityChanges(prev, payload)) this.emit("entity.upserted", payload, source.at, actorOf(source));
    return structuredClone(this.state.entities.get(id)!);
  }

  /**
   * Resolution pass for a name we have not seen: compare it with known
   * name-keyed entities of the same type. Externally keyed entities are never
   * candidates; their key is authoritative, however similar two names look.
   */
  private resolveName(id: string, type: string, name: string, source: StoredProvenance): string {
    if (!this.resolver.enabled) return id;
    let best: { entity: Entity; similarity: number } | undefined;
    for (const other of this.state.entities.values()) {
      if (other.type !== type || !other.id.startsWith("ent_") || !other.name) continue;
      const similarity = Math.max(...other.aliases.map((alias) => nameSimilarity(name, alias)), nameSimilarity(name, other.name));
      if (!best || similarity > best.similarity || (similarity === best.similarity && other.id < best.entity.id)) {
        best = { entity: other, similarity };
      }
    }
    if (!best) return id;
    const decision = decide(best.similarity, this.resolver);
    if (decision === "auto-merge") {
      this.emit("entity.aliased", { aliasId: id, primaryId: best.entity.id, similarity: best.similarity }, source.at, "resolver");
      return best.entity.id;
    }
    if (decision === "review") {
      const proposalId = `merge_${sha256Hex([id, best.entity.id].sort(compare).join("|")).slice(0, 12)}`;
      if (!this.state.proposals.has(proposalId)) {
        this.emit("merge.proposed", {
          id: proposalId, leftId: id, rightId: best.entity.id, leftName: name, rightName: best.entity.name!, similarity: best.similarity,
        }, source.at, "resolver");
      }
    }
    return id;
  }

  private prepareRelation(input: RelateInput): RelationPayload {
    const source = checkProvenance(input?.source);
    for (const field of ["from", "type", "to"] as const) {
      if (typeof input[field] !== "string" || input[field] === "") throw new Error(`World Model: relate() needs a ${field}`);
    }
    const from = this.state.resolve(input.from);
    const to = this.state.resolve(input.to);
    const validFrom = input.validFrom === undefined ? source.at : toIso(input.validFrom, "validFrom");
    const validTo = input.validTo === undefined ? undefined : toIso(input.validTo, "validTo");
    if (validTo !== undefined && validTo < validFrom) {
      throw new Error(`World Model: edge ${from} -[${input.type}]-> ${to} ends (${validTo}) before it starts (${validFrom})`);
    }
    const id = relationId(from, input.type, to, input.context, validFrom);
    // re-asserting an edge without saying otherwise keeps the cardinality it was created with
    const cardinality = input.cardinality ?? this.state.relations.get(id)?.cardinality ?? this.cardinality[input.type] ?? "one";
    if (cardinality !== "one" && cardinality !== "many") throw new Error(`World Model: unknown cardinality "${String(cardinality)}"`);
    return {
      id,
      from, type: input.type, to,
      ...(input.context !== undefined ? { context: input.context } : {}),
      attrs: compact(input.attrs), cardinality, validFrom,
      ...(validTo !== undefined ? { validTo } : {}),
      source,
    };
  }

  private writeRelation(payload: RelationPayload): Relationship {
    const prev = this.state.relations.get(payload.id);
    if (!prev || relationChanges(prev, payload)) this.emit("relation.asserted", payload, payload.source.at, actorOf(payload.source));
    return structuredClone(this.state.relations.get(payload.id)!);
  }
}

function actorOf(source: StoredProvenance): string {
  return typeof source.by === "string" && source.by !== "" ? source.by : source.kind;
}

function summarize(e: WorldEvent): string {
  switch (e.kind) {
    case "entity.upserted":
      return `${e.payload.id} (${e.payload.type})`;
    case "entity.aliased":
      return `${e.payload.aliasId} merged into ${e.payload.primaryId} (similarity ${e.payload.similarity.toFixed(3)})`;
    case "merge.proposed":
      return `${e.payload.leftName} ~ ${e.payload.rightName} (similarity ${e.payload.similarity.toFixed(3)}) queued for review`;
    case "relation.asserted":
      return `${e.payload.from} -[${e.payload.type}]-> ${e.payload.to}`;
    case "observation.recorded":
      return `observation ${e.payload.externalId} -> ${e.payload.entityId}`;
  }
}
