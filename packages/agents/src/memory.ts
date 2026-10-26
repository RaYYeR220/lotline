import { HMEM, recallQuirks, recallRulings, rememberQuirk, rememberRuling } from "@lotline/hmem";
import type { TraceLog } from "@lotline/core";
import type { PartnerMemory } from "./context.ts";
import { canonicalLot } from "./lotcodes.ts";
import type { TraceGraph } from "./tracer.ts";

/** Partner memory backed by the H-MEM engine, persisted between runs. */
export class HmemPartnerMemory implements PartnerMemory {
  readonly hmem: HMEM;

  constructor(dir: string | undefined, private readonly trace: TraceLog) {
    this.hmem = new HMEM(dir ? { dir } : {});
  }

  async recallQuirks(source: string) {
    const out = await recallQuirks(this.hmem, source, { trace: this.trace, agent: "SourceMapperAgent" });
    return out.filter((q) => !q.superseded).map((q) => ({ text: q.text, confidence: q.confidence, ledgerRef: q.ledgerRef }));
  }

  rememberQuirk(q: { source: string; quirk: string; evidenceRunId: string }) {
    return rememberQuirk(this.hmem, q);
  }

  async recallRulings(linkKey: string) {
    return (await recallRulings(this.hmem, linkKey)).map((r) => ({ ruling: r.ruling, reason: r.reason, runId: r.runId ?? "" }));
  }

  rememberRuling(r: { linkKey: string; ruling: "proven" | "unproven" | "rejected"; reason: string; runId: string }) {
    return rememberRuling(this.hmem, r);
  }
}

/** What this run taught us about partner systems, in words the next run's agents can use. */
export async function learnQuirks(memory: PartnerMemory, graph: TraceGraph, runId: string, trace: TraceLog): Promise<number> {
  const learned: { source: string; quirk: string }[] = [];
  for (const l of graph.links) {
    for (const e of l.evidence) {
      if (e.table === "receiving" && e.source === "wms" && e.fields.vendor_lot && e.fields.vendor_lot !== canonicalLot(e.fields.vendor_lot)) {
        learned.push({ source: "wms", quirk: `wms.receiving.vendor_lot spells packer lots with dashes and unpadded sequence, e.g. ${e.fields.vendor_lot} = ${canonicalLot(e.fields.vendor_lot)}` });
      }
      if (e.table === "receipts" && e.source === "retail" && e.fields.supplier_ref_lot) {
        const code = e.fields.supplier_ref_lot.split(":").at(-1)!;
        const chain = e.fields.chain_id ?? e.fields.supplier_ref_lot.split(":")[0];
        if (code.length <= 10 && code.toUpperCase().startsWith("PK")) learned.push({ source: "retail", quirk: `${chain} receiving truncates supplier lot codes to 10 characters (${e.fields.supplier_ref_lot}); match on prefix and corroborate with the delivery` });
        else if (code !== code.toUpperCase()) learned.push({ source: "retail", quirk: `${chain} receiving stores supplier lot codes in lower case (${e.fields.supplier_ref_lot})` });
      }
    }
    if (l.notes.some((n) => n.includes("clock"))) learned.push({ source: "wms", quirk: "wms.receiving timestamps can run up to a day behind the packer's ship date; tie loads by bill of lading" });
  }
  const unique = [...new Map(learned.map((q) => [q.quirk.replace(/\(.*\)|e\.g\..*/, ""), q])).values()];
  for (const q of unique) await memory.rememberQuirk({ ...q, evidenceRunId: runId });
  if (unique.length) {
    trace.emit({ agent_name: "SourceMapperAgent", action: "hmem.remember", input_summary: `${graph.links.length} links reviewed`, output_summary: `${unique.length} partner quirks stored for future runs`, status: "success", detail: { quirks: unique } });
  }
  return unique.length;
}
