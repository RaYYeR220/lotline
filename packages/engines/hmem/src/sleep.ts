// Preview-first sleep cycle. preview() computes the whole plan (consolidate,
// archive, synthesize) with reasons and guardrail notes and mutates nothing.
// execute() takes a backup first and then performs only what the plan lists;
// restore() rolls the store back to any backup and logs that it did.

import path from "node:path";
import { readJson, writeJsonAtomic } from "./jsonl.ts";
import type { ConflictService } from "./conflicts.ts";
import type { TrustLedger } from "./ledger.ts";
import type { MemoryStore } from "./store.ts";
import { cosine } from "./text.ts";
import type { Memory, MemorySnapshot, SleepItem, SleepPreview, SleepReport } from "./types.ts";
import { DAY_MS, DEFAULTS } from "./types.ts";

interface Backup {
  id: string;
  createdAt: number;
  seq: number;
  records: MemorySnapshot[];
}

export class SleepService {
  private readonly backups = new Map<string, Backup>();
  private readonly dir?: string;

  constructor(
    private readonly store: MemoryStore,
    private readonly ledger: TrustLedger,
    private readonly conflicts: ConflictService,
    private readonly clock: () => number,
    private readonly actor: string,
    dir?: string,
  ) {
    if (dir) this.dir = path.join(dir, "backups");
  }

  preview(): SleepPreview {
    const now = this.clock();
    const live = this.store.all();

    // Anything another record points at is referenced and never archived.
    const referenced = new Set<string>();
    const inbound = new Map<string, number>();
    const currentWinners = new Set<string>();
    for (const m of live) {
      for (const r of m.relatedTo) {
        referenced.add(r);
        inbound.set(r, (inbound.get(r) ?? 0) + 1);
      }
      if (m.supersedes) referenced.add(m.supersedes);
      if (m.supersededBy) currentWinners.add(m.supersededBy);
      for (const d of m.derivedFrom) referenced.add(d);
    }

    const items: SleepItem[] = [];
    const protectedList: SleepPreview["protected"] = [];
    const toArchive: string[] = [];
    for (const m of live) {
      const ageDays = (now - m.timestamp) / DAY_MS;
      const eligible = ageDays >= DEFAULTS.archiveMinDays && m.accessCount <= DEFAULTS.archiveMaxAccess && !referenced.has(m.id);
      if (!eligible) continue;
      const guardrail = this.guardrail(m, currentWinners, inbound.get(m.id) ?? 0);
      if (guardrail) {
        protectedList.push({ memoryId: m.id, guardrail });
        continue;
      }
      toArchive.push(m.id);
      items.push(this.item(m, now, "archive", `${Math.floor(ageDays)} days old, ${m.accessCount} accesses, unreferenced`, "sleep_archive"));
    }
    const archiving = new Set(toArchive);

    const toConsolidate: string[] = [];
    for (const m of live) {
      if (m.layer === "long_term" || archiving.has(m.id) || m.supersededBy || m.tags.includes("review")) continue;
      if (this.conflicts.hasOpen(m.id)) continue;
      const idleDays = (now - m.lastAccessed) / DAY_MS;
      if (idleDays < DEFAULTS.consolidationDays) continue;
      toConsolidate.push(m.id);
      items.push(this.item(m, now, "consolidate", `${m.layer} record idle ${Math.floor(idleDays)} days, promote to long_term`, "sleep_consolidate"));
    }

    // Near-duplicates merge into one derived record. Records that are archived,
    // superseded, derived, or have ever been in a conflict are left alone.
    const candidates = live.filter(
      (m) => !archiving.has(m.id) && !m.supersededBy && m.derivedFrom.length === 0 && this.conflicts.forMemory(m.id).length === 0,
    );
    const toSynthesize: string[][] = [];
    const used = new Set<string>();
    for (let i = 0; i < candidates.length; i++) {
      const seed = candidates[i];
      if (used.has(seed.id)) continue;
      const group = [seed];
      for (let j = i + 1; j < candidates.length; j++) {
        const other = candidates[j];
        if (used.has(other.id) || other.type !== seed.type) continue;
        if (cosine(seed.embedding!, other.embedding!) >= DEFAULTS.synthesisCosine) group.push(other);
      }
      if (group.length < 2) continue;
      for (const g of group) {
        used.add(g.id);
        items.push(this.item(g, now, "synthesize", `near-duplicate group of ${group.length} (cosine >= ${DEFAULTS.synthesisCosine})`, "sleep_synthesize"));
      }
      toSynthesize.push(group.map((g) => g.id));
    }

    return { createdAt: now, toConsolidate, toArchive, toSynthesize, items, protected: protectedList };
  }

  execute(plan: SleepPreview = this.preview(), opts: { actor?: string } = {}): SleepReport {
    const actor = opts.actor ?? this.actor;
    const backupId = this.backup();
    const actionLog = [`backup ${backupId} created`];
    const ledgerIds: string[] = [];
    const last = (id: string) => ledgerIds.push(this.ledger.history(id).at(-1)!.id);

    let consolidatedCount = 0;
    for (const id of plan.toConsolidate) {
      const m = this.store.get(id);
      if (!m || m.layer === "long_term") continue;
      this.store.update(id, { layer: "long_term" }, { action: "sleep_consolidate", actor, details: { backupId, from: m.layer } });
      last(id);
      consolidatedCount++;
      actionLog.push(`consolidated ${id}`);
    }

    let archivedCount = 0;
    for (const id of plan.toArchive) {
      const m = this.store.get(id);
      if (!m) continue;
      this.store.delete(id, {
        action: "sleep_archive",
        actor,
        reason: "sleep archive",
        details: { backupId, ageDays: Math.floor((this.clock() - m.timestamp) / DAY_MS), accessCount: m.accessCount },
      });
      last(id);
      archivedCount++;
      actionLog.push(`archived ${id}`);
    }

    let synthesizedCount = 0;
    for (const group of plan.toSynthesize) {
      const members = group.map((id) => this.store.get(id)).filter((m): m is Memory => !!m);
      if (members.length < 2) continue;
      const richest = members.reduce((a, b) => (b.content.length > a.content.length ? b : a));
      const memberIds = new Set(members.map((m) => m.id));
      const merged = this.store.add({
        content: richest.content,
        type: richest.type,
        layer: "long_term",
        tags: [...new Set(members.flatMap((m) => m.tags))],
        confidence: Math.max(...members.map((m) => m.confidence)),
        source: "sleep:synthesis",
        domain: richest.domain,
        derivedFrom: members.map((m) => m.id),
        provenance: { origin: "inference", learnedAt: this.clock(), label: `synthesized from ${members.length} near-duplicate memories` },
        actor,
      });
      // Inherit relationships that point outside the merged group.
      const inherited = [...new Set(members.flatMap((m) => m.relatedTo))].filter((r) => !memberIds.has(r) && r !== merged.id);
      this.store.update(merged.id, { relatedTo: [...new Set([...merged.relatedTo, ...inherited])].slice(0, DEFAULTS.relatedCap) }, {
        action: "sleep_synthesize",
        actor,
        details: { backupId, sources: [...memberIds] },
      });
      last(merged.id);
      for (const m of members) {
        this.store.delete(m.id, { action: "sleep_synthesize", actor, reason: `merged into ${merged.id}`, details: { backupId, into: merged.id } });
        last(m.id);
      }
      synthesizedCount++;
      actionLog.push(`synthesized ${merged.id} from ${[...memberIds].join(", ")}`);
    }

    return { backupId, consolidatedCount, archivedCount, synthesizedCount, actionLog, ledgerIds };
  }

  /** Roll the store back to a backup. The ledger keeps everything, plus a restore entry. */
  restore(backupId: string, opts: { actor?: string } = {}): void {
    const backup = this.backups.get(backupId) ?? (this.dir ? readJson<Backup>(path.join(this.dir, `${backupId}.json`)) : undefined);
    if (!backup) throw new Error(`H-MEM: unknown backup ${backupId}`);
    this.store.restoreAll(backup);
    this.ledger.log("*", "restore", opts.actor ?? this.actor, { details: { backupId, records: backup.records.length } });
  }

  listBackups(): string[] {
    return [...this.backups.keys()];
  }

  private backup(): string {
    const snap = this.store.snapshotAll();
    const id = `backup-${this.clock()}-${this.backups.size + 1}`;
    const backup: Backup = { id, createdAt: this.clock(), ...snap };
    this.backups.set(id, backup);
    if (this.dir) writeJsonAtomic(path.join(this.dir, `${id}.json`), backup);
    return id;
  }

  private guardrail(m: Memory, currentWinners: Set<string>, inboundLinks: number): string | undefined {
    if (m.supersedes || currentWinners.has(m.id)) return "superseding/current record";
    if (m.derivedFrom.length > 0) return "derived or synthesized memory";
    if (m.relatedTo.length + inboundLinks >= DEFAULTS.hubLinks) return "relationship hub";
    if (this.conflicts.hasOpen(m.id)) return "open conflict";
    if (m.confidence >= DEFAULTS.archiveProtectConfidence) return "high confidence";
    return undefined;
  }

  private item(m: Memory, now: number, action: SleepItem["action"], reason: string, ledgerAction: SleepItem["expectedLedgerAction"]): SleepItem {
    return {
      memoryId: m.id,
      contentPreview: m.content.length > 80 ? `${m.content.slice(0, 77)}...` : m.content,
      action,
      reason,
      confidence: m.confidence,
      accessCount: m.accessCount,
      ageDays: Math.floor((now - m.timestamp) / DAY_MS),
      idleDays: Math.floor((now - m.lastAccessed) / DAY_MS),
      expectedLedgerAction: ledgerAction,
    };
  }
}
