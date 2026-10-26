// Dreaming: constructive synthesis behind a human approval boundary. dream()
// clusters related memories and returns proposals (insights, domain
// reclassifications, invariants); nothing becomes memory until approve().
// Cleanup is not dreaming's job; that belongs to the sleep cycle.

import path from "node:path";
import { appendJsonl, readJsonl } from "./jsonl.ts";
import type { TrustLedger } from "./ledger.ts";
import type { MemoryStore } from "./store.ts";
import { cosine, jaccard, namespaceFor } from "./text.ts";
import type { DreamProposal, Memory } from "./types.ts";
import { DEFAULTS, clamp01 } from "./types.ts";

const MAX_CLUSTER = 12;
const brief = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export class DreamingService {
  private readonly proposals = new Map<string, DreamProposal>();
  private readonly file?: string;

  constructor(
    private readonly store: MemoryStore,
    private readonly ledger: TrustLedger,
    private readonly clock: () => number,
    private readonly actor: string,
    dir?: string,
  ) {
    if (dir) {
      this.file = path.join(dir, "proposals.jsonl");
      for (const p of readJsonl<DreamProposal>(this.file)) this.proposals.set(p.id, p);
    }
  }

  /** Multi-signal relatedness: content, tags, shared domain and type, entities. */
  relatedness(a: Memory, b: Memory): number {
    return (
      0.4 * Math.max(0, cosine(a.embedding!, b.embedding!)) +
      0.15 * jaccard(a.tags, b.tags) +
      0.15 * (a.domain === b.domain ? 1 : 0) +
      0.15 * (a.type === b.type ? 1 : 0) +
      0.15 * jaccard(a.entities.map((e) => e.name), b.entities.map((e) => e.name))
    );
  }

  /** Generate new proposals for review. The store is not touched. */
  dream(): DreamProposal[] {
    const live = this.store.all().filter((m) => !m.supersededBy);
    const created: DreamProposal[] = [];
    const propose = (p: Omit<DreamProposal, "id" | "status" | "createdAt">) => {
      if (this.known(p)) return false;
      const proposal: DreamProposal = { ...p, id: `dream-${this.proposals.size + 1}`, status: "pending_review", createdAt: this.clock() };
      this.persist(proposal);
      created.push(proposal);
      this.ledger.log(proposal.id, "dream_proposed", this.actor, { details: { type: p.type, derivedFrom: p.derivedFrom } });
      return true;
    };

    // 1. Insights from clusters of related memories.
    let insights = 0;
    for (const cluster of this.cluster(live)) {
      if (insights >= DEFAULTS.maxDreamProposalsPerType) break;
      const domains = [...new Set(cluster.map((m) => m.domain))].join("/");
      const pairs: number[] = [];
      for (let i = 0; i < cluster.length; i++) for (let j = i + 1; j < cluster.length; j++) pairs.push(this.relatedness(cluster[i], cluster[j]));
      const ok = propose({
        type: "insight",
        content: `Across ${cluster.length} related memories (${domains}): ${cluster.map((m) => brief(m.content)).join(" + ")}`,
        derivedFrom: cluster.map((m) => m.id),
        confidence: Number(clamp01(pairs.reduce((s, x) => s + x, 0) / pairs.length).toFixed(3)),
      });
      if (ok) insights++;
    }

    // 2. Domain suggestions for uncategorized memories, by vote of their nearest categorized neighbours.
    let domainSuggestions = 0;
    for (const m of live) {
      if (domainSuggestions >= DEFAULTS.maxDreamProposalsPerType) break;
      if (m.domain !== "general") continue;
      const votes = new Map<string, number>();
      for (const other of live) {
        if (other.id === m.id || other.domain === "general") continue;
        const sim = cosine(m.embedding!, other.embedding!);
        if (sim >= 0.3) votes.set(other.domain, (votes.get(other.domain) ?? 0) + sim);
      }
      const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked.length === 0) continue;
      const total = ranked.reduce((s, [, v]) => s + v, 0);
      const [domain, weight] = ranked[0];
      const ok = propose({
        type: "domain",
        content: `Reclassify "${brief(m.content, 60)}" as ${domain}`,
        derivedFrom: [m.id],
        suggestedDomain: domain,
        confidence: Number((weight / total).toFixed(3)),
      });
      if (ok) domainSuggestions++;
    }

    // 3. Invariants from preference, personal and correction signals, per domain.
    let invariants = 0;
    const signals = live.filter(
      (m) =>
        m.provenance.origin !== "inference" &&
        (m.type === "preference" || m.type === "personal" || m.tags.includes("event:user_correction") || /user_correction/i.test(m.source)),
    );
    const byDomain = new Map<string, Memory[]>();
    for (const m of signals) byDomain.set(m.domain, [...(byDomain.get(m.domain) ?? []), m]);
    for (const [domain, list] of byDomain) {
      if (invariants >= DEFAULTS.maxDreamProposalsPerType) break;
      if (list.length < DEFAULTS.dreamClusterMinSize) continue;
      const members = list.slice(0, MAX_CLUSTER);
      const ok = propose({
        type: "invariant",
        content: `Stable pattern in ${domain}: ${members.map((m) => brief(m.content)).join("; ")}`,
        derivedFrom: members.map((m) => m.id),
        confidence: 0.75,
      });
      if (ok) invariants++;
    }

    return created;
  }

  get(id: string): DreamProposal | undefined {
    return this.proposals.get(id);
  }

  all(): DreamProposal[] {
    return [...this.proposals.values()];
  }

  pending(): DreamProposal[] {
    return this.all().filter((p) => p.status === "pending_review");
  }

  /**
   * Approve a proposal. Insights become long-term factual memories, invariants
   * long-term preferences (both with derivedFrom lineage); domain proposals
   * reclassify their source records and return undefined.
   */
  approve(proposalId: string, opts: { actor?: string } = {}): Memory | undefined {
    const p = this.mustBePending(proposalId);
    const actor = opts.actor ?? this.actor;
    p.status = "approved";
    p.decidedAt = this.clock();
    p.decidedBy = actor;
    this.persist(p);
    this.ledger.log(p.id, "dream_approved", actor, { details: { type: p.type, derivedFrom: p.derivedFrom } });

    if (p.type === "domain") {
      for (const id of p.derivedFrom) {
        const m = this.store.get(id);
        if (m && p.suggestedDomain) {
          this.store.update(id, { domain: p.suggestedDomain, namespace: namespaceFor(p.suggestedDomain, m.type) }, {
            actor,
            details: { dreamProposal: p.id },
          });
        }
      }
      return undefined;
    }
    return this.store.add({
      content: p.content,
      type: p.type === "insight" ? "factual" : "preference",
      layer: "long_term",
      tags: [`dream:${p.type}`],
      confidence: p.type === "insight" ? clamp01(Math.max(0.6, p.confidence)) : 0.75,
      source: "dreaming",
      derivedFrom: p.derivedFrom,
      provenance: { origin: "inference", learnedAt: this.clock(), label: `approved ${p.type} proposal ${p.id}` },
      actor,
    });
  }

  /** Reject a proposal: logged, never materialized. */
  reject(proposalId: string, opts: { actor?: string; reason?: string } = {}): void {
    const p = this.mustBePending(proposalId);
    const actor = opts.actor ?? this.actor;
    p.status = "rejected";
    p.decidedAt = this.clock();
    p.decidedBy = actor;
    this.persist(p);
    this.ledger.log(p.id, "dream_rejected", actor, { details: { type: p.type, reason: opts.reason } });
  }

  // Connected components over the "related enough" graph, in insertion order.
  private cluster(live: Memory[]): Memory[][] {
    const parent = live.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        if (this.relatedness(live[i], live[j]) >= DEFAULTS.dreamRelatedness) parent[find(j)] = find(i);
      }
    }
    const groups = new Map<number, Memory[]>();
    live.forEach((m, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), m]));
    return [...groups.values()].filter((g) => g.length >= DEFAULTS.dreamClusterMinSize).map((g) => g.slice(0, MAX_CLUSTER));
  }

  // The same proposal (type + sources + target) is never raised twice, whatever its status.
  private known(p: Pick<DreamProposal, "type" | "derivedFrom" | "suggestedDomain">): boolean {
    const key = (x: Pick<DreamProposal, "type" | "derivedFrom" | "suggestedDomain">) =>
      `${x.type}|${[...x.derivedFrom].sort().join(",")}|${x.suggestedDomain ?? ""}`;
    const k = key(p);
    return this.all().some((q) => key(q) === k);
  }

  private mustBePending(id: string): DreamProposal {
    const p = this.proposals.get(id);
    if (!p || p.status !== "pending_review") throw new Error(`H-MEM: no pending proposal ${id}`);
    return p;
  }

  private persist(p: DreamProposal): void {
    this.proposals.set(p.id, p);
    if (this.file) appendJsonl(this.file, p);
  }
}
