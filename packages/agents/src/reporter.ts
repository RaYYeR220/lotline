import { z } from "zod";
import type { DraftNotice, LocationAction, RecallScope, TraceLink } from "@lotline/core";
import type { AgentContext } from "./context.ts";
import { buildSpreadsheet } from "./fda.ts";
import type { TraceGraph } from "./tracer.ts";

const Draft = z.object({ subject: z.string(), body: z.string() });

const SYSTEM = `You draft recall notifications for a produce distributor's food-safety lead. Plain, specific, no marketing tone.
State the product, the lot codes, what to do (pull and hold, or hold pending confirmation), and that the distributor will confirm by phone.
Reply with one JSON object: {"subject","body"}.`;

/** Reporter: the FDA sortable spreadsheet plus notification drafts per recipient. Nothing is sent. */
export async function report(ctx: AgentContext, scope: RecallScope, graph: TraceGraph, actions: LocationAction[]): Promise<{ spreadsheet: { csv: string; rows: number }; drafts: DraftNotice[] }> {
  const sheet = buildSpreadsheet(graph.links as TraceLink[], scope.productText);
  ctx.trace.emit({
    agent_name: "Reporter", action: "spreadsheet.built", input_summary: `${graph.links.length} links`,
    output_summary: `${sheet.rows} KDE rows from proven links; ${sheet.unproven.length} unproven links listed separately`, status: "success",
  });

  const recipients = new Map<string, LocationAction[]>();
  for (const a of actions.filter((x) => x.kind === "PULL" || x.kind === "HOLD")) {
    const key = a.locationId.startsWith("FS") ? a.locationId : a.locationName.split(/\s#|\s\(/)[0];
    (recipients.get(key) ?? recipients.set(key, []).get(key)!).push(a);
  }
  for (const e of graph.external) (recipients.get(`firm:${e.firm}`) ?? recipients.set(`firm:${e.firm}`, []).get(`firm:${e.firm}`)!);

  const drafts: DraftNotice[] = [];
  for (const [to, list] of recipients) {
    const lots = [...new Set(list.flatMap((a) => a.lots))];
    const lines = list.map((a) => `${a.locationName}: ${a.kind}`).join("\n");
    const external = to.startsWith("firm:") ? graph.external.filter((e) => `firm:${e.firm}` === to) : [];
    const fallback = {
      subject: `RECALL ${scope.recallClass ? `Class ${scope.recallClass} ` : ""}- ${scope.productText.slice(0, 60)}`,
      body: [
        `Recall notice from Northgate Produce food safety.`,
        `Product: ${scope.productText}`,
        `Hazard: ${scope.hazard ?? "see FDA notice"}`,
        external.length ? `We shipped you lots ${external.map((e) => e.lot).join(", ")}.` : `Lots delivered to you: ${lots.join(", ")}`,
        lines,
        `PULL: remove from sale and hold for pickup. HOLD: stop sale pending confirmation.`,
        `We will call to confirm receipt of this notice.`,
      ].filter(Boolean).join("\n"),
    };
    const res = await ctx.models.chat({
      agent: "Reporter", lane: "fast", purpose: `notification draft for ${to}`, system: SYSTEM,
      user: JSON.stringify({ to, product: scope.productText, hazard: scope.hazard, lots: external.length ? external.map((e) => e.lot) : lots, actions: lines }),
      schema: Draft, ruleFallback: () => fallback,
    });
    drafts.push({ to, subject: res.json.subject, body: res.json.body });
  }
  return { spreadsheet: { csv: sheet.csv, rows: sheet.rows }, drafts };
}
