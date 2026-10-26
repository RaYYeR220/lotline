// Append-only trust ledger. Every mutation of memory writes one entry here
// before (or as) it happens; entries are never edited or removed, and the
// file store only ever grows. history() replays a memory's full change record
// from the previousState/newState snapshots on each entry.

import path from "node:path";
import { appendJsonl, readJsonl } from "./jsonl.ts";
import type { LedgerAction, LedgerEntry, MemorySnapshot } from "./types.ts";

export interface LedgerExtra {
  previousState?: MemorySnapshot;
  newState?: MemorySnapshot;
  details?: Record<string, unknown>;
}

export class TrustLedger {
  private readonly entries: LedgerEntry[] = [];
  private readonly byId = new Map<string, LedgerEntry>();
  private readonly file?: string;

  constructor(private readonly clock: () => number, dir?: string) {
    if (dir) {
      this.file = path.join(dir, "ledger.jsonl");
      for (const e of readJsonl<LedgerEntry>(this.file)) this.index(e);
    }
  }

  log(memoryId: string, action: LedgerAction, actor: string, extra: LedgerExtra = {}): LedgerEntry {
    const entry: LedgerEntry = {
      id: `led-${this.entries.length + 1}`,
      memoryId,
      action,
      actor,
      timestamp: this.clock(),
      ...structuredClone(extra),
    };
    this.index(entry);
    if (this.file) appendJsonl(this.file, entry);
    return entry;
  }

  get(id: string): LedgerEntry | undefined {
    return this.byId.get(id);
  }

  /** Every entry for one memory (or proposal), oldest first. */
  history(memoryId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.memoryId === memoryId);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  range(from: number, to: number): LedgerEntry[] {
    return this.entries.filter((e) => e.timestamp >= from && e.timestamp <= to);
  }

  byAction(action: LedgerAction): LedgerEntry[] {
    return this.entries.filter((e) => e.action === action);
  }

  stats(): { byAction: Record<string, number>; byActor: Record<string, number>; total: number } {
    const byAction: Record<string, number> = {};
    const byActor: Record<string, number> = {};
    for (const e of this.entries) {
      byAction[e.action] = (byAction[e.action] ?? 0) + 1;
      byActor[e.actor] = (byActor[e.actor] ?? 0) + 1;
    }
    return { byAction, byActor, total: this.entries.length };
  }

  /** Audit export: the full ledger as JSONL text. */
  export(): string {
    return this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : "");
  }

  private index(e: LedgerEntry): void {
    this.entries.push(e);
    this.byId.set(e.id, e);
  }
}
