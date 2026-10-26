// Record shapes for the World Model engine. The canonical store is the event
// log (WorldEvent); every other record here is a projection of it.

export type ISODate = string;

/**
 * Where a write came from. Every write carries one: no provenance, no write.
 * `at` is the observation time (when the fact was true in the source system),
 * never the wall clock of the process that recorded it.
 */
export interface Provenance extends ProvenanceFields {
  at: ISODate | Date;
}

export interface ProvenanceFields {
  kind: string;
  /** agent, user or pipeline that made the write */
  by?: string;
  /** source-side reference, e.g. the query ids that returned the rows */
  ref?: string;
  url?: string;
  runId?: string;
  /** domain-specific provenance fields are kept verbatim */
  [extra: string]: unknown;
}

/** Provenance after validation: `at` is always a full ISO-8601 UTC string. */
export interface StoredProvenance extends Provenance {
  at: ISODate;
}

export type EntityState = "emerging" | "active" | "archived";

export interface Entity {
  id: string;
  type: string;
  /** canonical display name, when known */
  name?: string;
  /** every name the sources used for this entity (merge survivors included) */
  aliases: string[];
  attrs: Record<string, unknown>;
  /** "emerging" = only seen as an edge endpoint so far */
  state: EntityState;
  source: StoredProvenance;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/**
 * How an edge type behaves when a new edge with the same (from, type, context)
 * arrives. "one": the newer edge supersedes the older (custody, membership).
 * "many": edges coexist (a lot shipped to several stores, a repack with several
 * input lots).
 */
export type Cardinality = "one" | "many";

/** Bitemporal edge. `validTo` unset means the edge is still open. */
export interface Relationship {
  id: string;
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs: Record<string, unknown>;
  cardinality: Cardinality;
  validFrom: ISODate;
  /** end of validity: asserted by the writer, or set when a successor superseded this edge */
  validTo?: ISODate;
  /** the edge that closed this one (cardinality "one" only; derived, never written) */
  supersededBy?: string;
  source: StoredProvenance;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** One processed observation; its checksum is the ingest dedupe key. */
export interface ObservationRecord {
  externalId: string;
  entityId: string;
  checksum: string;
  at: ISODate;
  mentions: string[];
}

/** A near-duplicate pair waiting for an operator; never merged automatically. */
export interface MergeProposal {
  id: string;
  leftId: string;
  rightId: string;
  leftName: string;
  rightName: string;
  similarity: number;
}

export interface EntityAlias {
  aliasId: string;
  primaryId: string;
  similarity: number;
}

/** Entity write as recorded in the log (input already validated and resolved). */
export interface EntityPayload {
  id: string;
  type: string;
  name?: string;
  attrs: Record<string, unknown>;
  state?: EntityState;
  source: StoredProvenance;
}

/** Edge write as recorded in the log. */
export interface RelationPayload {
  id: string;
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs: Record<string, unknown>;
  cardinality: Cardinality;
  validFrom: ISODate;
  validTo?: ISODate;
  source: StoredProvenance;
}

export interface EventPayloads {
  "entity.upserted": EntityPayload;
  "entity.aliased": EntityAlias;
  "merge.proposed": MergeProposal;
  "relation.asserted": RelationPayload;
  "observation.recorded": ObservationRecord;
}

export type EventKind = keyof EventPayloads;

interface EventEnvelope {
  /** storage schema version */
  v: 1;
  /** position in the log: 1, 2, 3, ... with no gaps */
  seq: number;
  id: string;
  /** valid time: the provenance timestamp of the write */
  at: ISODate;
  /** transaction time: when this process appended the event */
  recordedAt: ISODate;
  actor: string;
  runId?: string;
}

/** Append-only log entry. State is a fold over these, in seq order. */
export type WorldEvent = { [K in EventKind]: EventEnvelope & { kind: K; payload: EventPayloads[K] } }[EventKind];

export interface AuditEntry {
  seq: number;
  at: ISODate;
  recordedAt: ISODate;
  kind: EventKind;
  actor: string;
  summary: string;
  eventId: string;
  runId?: string;
}

export interface WorldShape {
  entities: Entity[];
  relationships: Relationship[];
  aliases: [string, string][];
  observations: ObservationRecord[];
  mergeProposals: MergeProposal[];
}

// ------------------------------------------------------------------ inputs

export interface UpsertEntityInput {
  type: string;
  /** an id the caller already holds as stable (e.g. a lot code namespaced by type) */
  id?: string;
  /** authoritative external identifier: id becomes `type:system:id` */
  externalKey?: { system: string; id: string };
  /** name-keyed entities (no id, no externalKey) derive their id from this */
  name?: string;
  attrs?: Record<string, unknown>;
  state?: EntityState;
  source: Provenance;
}

export interface RelateInput {
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs?: Record<string, unknown>;
  /** start of validity; defaults to source.at */
  validFrom?: ISODate | Date;
  /** explicit end of validity */
  validTo?: ISODate | Date;
  /** defaults to the per-type option, then "one" */
  cardinality?: Cardinality;
  source: Provenance;
}

/** A raw observation entering batch ingest. */
export interface IngestObservation {
  externalId: string;
  /** entity type the observation materializes as (default "item") */
  type?: string;
  title: string;
  text?: string;
  at: ISODate;
  /** `at` defaults to the observation's own `at` */
  source: ProvenanceFields & { at?: ISODate | Date };
  entities?: { type: string; name: string }[];
}

export interface IngestReport {
  runId: string;
  /** inputs that produced at least one write */
  processed: number;
  /** inputs already reflected in the world */
  skipped: number;
  /** events appended by this run */
  appended: number;
  /** canonical state differs from before the run */
  changed: boolean;
}

export interface WorldModelOptions {
  namespace?: string;
  /** "memory" keeps the log in-process; "file" appends it to a JSONL file */
  storage?: "memory" | "file";
  /** event log path, required for "file" storage */
  path?: string;
  /** transaction-time clock (recordedAt); record times always come from provenance */
  clock?: () => Date;
  /** per-edge-type cardinality when relate() does not say */
  cardinality?: Record<string, Cardinality>;
  resolver?: { enabled?: boolean; autoMergeAt?: number; reviewFloor?: number };
}
