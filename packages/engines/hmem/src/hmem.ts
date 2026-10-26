// The H-MEM facade: one object wiring the services together over a shared
// clock, actor, embedder and (optionally) a local file store directory.
//
//   const memory = new HMEM({ dir: "data/hmem" });
//   memory.add({ content, source });
//   memory.query("...").context   // domain-grouped block for a prompt
//
// With `dir`, working and long-term memories, the trust ledger, conflict
// records, dream proposals and sleep backups persist as JSONL/JSON files and
// are picked up by the next instance over the same directory.

import { ConflictService } from "./conflicts.ts";
import { DreamingService } from "./dreaming.ts";
import { TrustLedger } from "./ledger.ts";
import type { QueryOptions, QueryResult } from "./retrieval.ts";
import { RetrievalService } from "./retrieval.ts";
import { SleepService } from "./sleep.ts";
import { MemoryStore } from "./store.ts";
import { HashEmbedder } from "./text.ts";
import type { AddInput, Embedder, FeedbackKind, Memory } from "./types.ts";

export interface HMEMOptions {
  /** Injectable time source (ms). Defaults to Date.now. */
  clock?: () => number;
  /** Directory for the local file store. Omit for a purely in-memory instance. */
  dir?: string;
  /** Alias of `dir`. */
  persistDir?: string;
  /** Default actor written to the ledger. */
  actor?: string;
  /** Text embedder; defaults to the offline hashed bag-of-words/trigram embedder. */
  embedder?: Embedder;
}

export class HMEM {
  readonly clock: () => number;
  readonly actor: string;
  readonly embedder: Embedder;
  readonly dir?: string;
  readonly ledger: TrustLedger;
  readonly store: MemoryStore;
  readonly retrieval: RetrievalService;
  readonly conflicts: ConflictService;
  readonly sleep: SleepService;
  readonly dreaming: DreamingService;

  constructor(opts: HMEMOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.actor = opts.actor ?? "hmem";
    this.embedder = opts.embedder ?? new HashEmbedder();
    this.dir = opts.dir ?? opts.persistDir;
    // The ledger loads first: the store derives its id sequence from it.
    this.ledger = new TrustLedger(this.clock, this.dir);
    this.store = new MemoryStore(this.clock, this.ledger, this.embedder, this.actor, this.dir);
    this.retrieval = new RetrievalService(this.store, this.ledger, this.embedder, this.clock, this.actor);
    this.conflicts = new ConflictService(this.store, this.ledger, this.clock, this.actor, this.dir);
    this.sleep = new SleepService(this.store, this.ledger, this.conflicts, this.clock, this.actor, this.dir);
    this.dreaming = new DreamingService(this.store, this.ledger, this.clock, this.actor, this.dir);
  }

  add(input: AddInput): Memory {
    return this.store.add(input);
  }

  query(text: string, opts?: QueryOptions): QueryResult {
    return this.retrieval.query(text, opts);
  }

  feedback(memoryId: string, kind: FeedbackKind, actor?: string): void {
    this.retrieval.feedback(memoryId, kind, actor);
  }

  /** Reinjection shortcut: the domain-grouped context block for a prompt. */
  context(text: string, opts?: QueryOptions): string {
    return this.retrieval.query(text, opts).context;
  }
}
