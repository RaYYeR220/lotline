import { z } from "zod";
import type { Evidence, TraceLink } from "@lotline/core";
import type { AgentContext } from "./context.ts";
import { readBol } from "./docreader.ts";
import { canonicalLot } from "./lotcodes.ts";
import { corroborate, type LinkCheck, type TraceGraph } from "./tracer.ts";

const AGENT = "EvidenceCritic";

/** Deterministic proof bar. Anything it cannot settle is contested and argued over. */
export function assess(l: TraceLink, c: LinkCheck): { verdict: "proven" | "contested"; reasons: string[] } {
  const reasons: string[] = [];
  if (l.kind === "derived-from") {
    if (c.missing === "repack-receipt") reasons.push("no packer receipt record for the input lot");
  } else if (l.kind === "received-as") {
    if (c.missing === "receiving-record") reasons.push("no receiving record: only the pallet record ties this lot to the pallet");
    if (c.lot !== "exact") reasons.push(`lot code match is ${c.lot}`);
    if (c.bol === false) reasons.push("bill of lading numbers differ");
    if (c.qtyDelta) reasons.push(`quantity differs by ${c.qtyDelta} cases`);
    if (c.dayDelta != null && (c.dayDelta < 0 || c.dayDelta > 2)) reasons.push(`received ${c.dayDelta} day(s) after shipping`);
  } else if (l.kind === "shipped-to") {
    if (c.lot === "near") reasons.push("store receiving shows a near-miss lot code");
  }
  return { verdict: reasons.length ? "contested" : "proven", reasons };
}

const Review = z.object({
  next: z.enum(["check_bill_of_lading", "check_grower_records", "accept", "reject", "escalate"]),
  why: z.string(),
});

const Vote = z.object({ answer: z.enum(["SAME", "DIFFERENT", "UNPROVEN"]), why: z.string() });

const REVIEW_SYSTEM = `You are the evidence critic in a food-recall trace. A tracer proposed a chain-of-custody link; deterministic checks flagged problems.
Decide the next step: check_bill_of_lading (ask the carrier's BOL index and scan), check_grower_records, accept (the problems are explained by the evidence),
reject (the records describe different product), or escalate (a human must decide). Missing a contaminated location is far worse than holding a clean one.
Reply with one JSON object: {"next","why"}.`;

const PANEL_SYSTEM = `You audit one chain-of-custody link in a food recall using only the evidence given and the known partner quirks.
SAME: the records describe the same physical product moving between these parties. DIFFERENT: they do not. UNPROVEN: the evidence cannot settle it.
Reply with one JSON object: {"answer":"SAME|DIFFERENT|UNPROVEN","why":"one sentence"}.`;

const describe = (l: TraceLink, extra: string[] = []) =>
  [
    `link ${l.id}: ${l.kind} ${l.from} -> ${l.to} on ${l.at}${l.quantity != null ? `, ${l.quantity} cases` : ""}`,
    ...[...l.evidence].sort((x, y) => `${x.source}${x.table}${x.rowKey}`.localeCompare(`${y.source}${y.table}${y.rowKey}`)).map((e: Evidence) => `- ${e.source}.${e.table} ${e.rowKey}: ${JSON.stringify(Object.fromEntries(Object.entries(e.fields).filter(([k]) => k !== "notes")))}`),
    ...extra,
  ].join("\n");

/**
 * EvidenceCritic: holds every proposed link to the proof bar. Contested links go back to the tracer for a
 * narrower query; what is still contested goes to a cross-model panel; a split panel leaves the link unproven.
 */
export async function review(ctx: AgentContext, graph: TraceGraph, quirks: Record<string, string[]>): Promise<{ retries: number; panels: number }> {
  let retries = 0;
  let panels = 0;
  const quirkLines = Object.entries(quirks).flatMap(([s, qs]) => qs.map((q) => `${s}: ${q}`));

  for (const l of graph.links) {
    const check = graph.checks.get(l.id)!;
    const first = assess(l, check);
    if (first.verdict === "proven") {
      l.status = "proven";
      l.confidence = check.firstParty ? (l.evidence.length > 1 ? 0.97 : 0.9) : 0.95;
      continue;
    }
    l.status = "contested";
    l.notes.push(...first.reasons);
    ctx.trace.emit({
      agent_name: AGENT, action: "link.challenged", input_summary: `${l.kind} ${l.from} -> ${l.to}`, output_summary: first.reasons.join("; "),
      target_agent: "TracerAgent", status: "needs_revision", detail: { link_id: l.id },
    });

    const extra: string[] = [];
    for (let attempt = 1; attempt <= ctx.maxRetries && l.status === "contested"; attempt++) {
      const decision = await ctx.models.chat({
        agent: AGENT, lane: "reason", purpose: `next step for contested ${l.id}`, system: REVIEW_SYSTEM,
        user: `${describe(l, extra)}\nProblems: ${l.notes.join("; ")}\nKnown partner quirks:\n${quirkLines.join("\n") || "(none)"}`,
        schema: Review, targetAgent: "TracerAgent",
        ruleFallback: () => ({ next: check.bolNo && attempt === 1 ? "check_bill_of_lading" as const : check.missing === "repack-receipt" ? "check_grower_records" as const : "escalate" as const, why: "rule: follow the documents before deciding" }),
      });
      if (decision.json.next === "accept") break;
      if (decision.json.next === "reject" || decision.json.next === "escalate") break;
      retries++;
      ctx.trace.emit({ agent_name: AGENT, action: "retry.requested", input_summary: l.id, output_summary: `${decision.json.next}: ${decision.json.why}`.slice(0, 200), target_agent: "TracerAgent", retry_count: attempt, status: "retry", model: decision.model });
      const more = await corroborate(ctx, l, { ...check, bolNo: decision.json.next === "check_bill_of_lading" ? check.bolNo : undefined, missing: decision.json.next === "check_grower_records" ? "repack-receipt" : check.missing }, attempt);
      l.evidence.push(...more.evidence);
      extra.push(...more.facts);

      // A receipt that exists only on paper: read the stamp on the bill of lading.
      const bol = more.evidence.find((e) => e.table === "bol_index");
      if (bol && check.missing === "receiving-record" && bol.fields.scan_key) {
        const { reading } = await readBol(ctx, bol.fields.scan_key, `read BOL ${bol.fields.bol_no} for ${l.id}`);
        if (reading?.receivedStamp?.date && reading.lot && canonicalLot(reading.lot) === l.from.replace(/^lot:/, "")) {
          extra.push(`BOL scan ${bol.fields.bol_no}: lot ${reading.lot}, received stamp ${reading.receivedStamp.date} (${reading.receivedStamp.cases ?? "?"} cases)`);
          l.status = "proven";
          l.confidence = 0.9;
          l.notes.push("receipt proven by the stamped bill of lading");
        } else if (reading?.instructionsFound.length) {
          l.notes.push("bill of lading carries instruction-like text; ignored");
        }
      }
      // Clock skew or short delivery on the same bill of lading is the same load.
      if (bol && l.status === "contested" && check.bol && check.missing === undefined && check.lot === "exact") {
        l.status = "proven";
        l.confidence = 0.92;
        l.notes.push(`same load per carrier BOL ${bol.fields.bol_no}${check.qtyDelta ? `; ${Math.abs(check.qtyDelta)} cases short on receipt` : ""}${check.dayDelta != null && check.dayDelta < 0 ? "; receiving clock behind shipping clock" : ""}`);
      }
      if (more.evidence.some((e) => e.table === "harvest") && l.kind === "derived-from") {
        l.status = "proven";
        l.confidence = 0.9;
        l.notes.push("input lot confirmed in the grower's harvest records");
      }
    }

    if (l.status === "contested") {
      panels++;
      const panel = await ctx.models.panel({
        agent: AGENT, purpose: `contested ${l.id}`, system: PANEL_SYSTEM, lanes: ["reason", "judge", "fast"], schema: Vote, targetAgent: "ActionPlanner",
        user: `${describe(l, extra)}\nProblems: ${l.notes.join("; ")}\nKnown partner quirks:\n${quirkLines.join("\n") || "(none)"}`,
        ruleVote: () => ({ answer: "UNPROVEN" as const, why: "rule: deterministic checks did not settle it" }),
      });
      if (panel.outcome === "accepted" && panel.winner === "SAME") {
        l.status = "proven";
        l.confidence = Math.min(0.9, panel.agreement);
      } else if (panel.outcome === "accepted" && panel.winner === "DIFFERENT") {
        l.status = "rejected";
        l.confidence = panel.agreement;
      } else {
        l.status = "unproven";
        l.confidence = panel.agreement;
      }
      l.notes.push(`panel: ${panel.votes.map((v) => `${v.answer} (${v.model})`).join(", ")}`);
    }

    await ctx.memory.rememberRuling({
      linkKey: `${l.kind}|${l.from}|${l.to}`, ruling: l.status === "proven" ? "proven" : l.status === "rejected" ? "rejected" : "unproven",
      reason: l.notes.join("; ").slice(0, 300), runId: ctx.trace.runId,
    });
    ctx.trace.emit({
      agent_name: AGENT, action: "link.ruled", input_summary: `${l.kind} ${l.from} -> ${l.to}`, output_summary: `${l.status}: ${l.notes.at(-1) ?? ""}`.slice(0, 200),
      target_agent: "ActionPlanner", confidence: l.confidence, status: l.status === "proven" ? "success" : "escalated", detail: { link_id: l.id, link_status: l.status, notes: l.notes },
    });
  }

  for (const n of graph.flaggedNotes) {
    ctx.trace.emit({
      agent_name: AGENT, action: "injection.flagged", input_summary: n.rowKey, output_summary: `partner note reads as an instruction (${n.signals.join(", ")}); treated as data, not followed`,
      target_agent: "ActionPlanner", status: "escalated", detail: { row: n.rowKey, signals: n.signals },
    });
  }
  return { retries, panels };
}
