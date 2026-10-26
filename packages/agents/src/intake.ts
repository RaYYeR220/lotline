import { createHash } from "node:crypto";
import { z } from "zod";
import type { RecallScope } from "@lotline/core";
import type { AgentContext } from "./context.ts";

export const COMMODITIES = [
  "romaine", "cucumbers", "cantaloupe", "bell peppers", "tomatoes", "cilantro", "sprouts", "soft cheese", "shell eggs", "finfish",
] as const;

const ALIASES: Record<string, (typeof COMMODITIES)[number]> = {
  lettuce: "romaine", romaine: "romaine", cucumber: "cucumbers", cucumbers: "cucumbers", cantaloupe: "cantaloupe", melon: "cantaloupe",
  pepper: "bell peppers", peppers: "bell peppers", tomato: "tomatoes", tomatoes: "tomatoes", cilantro: "cilantro", herbs: "cilantro",
  sprouts: "sprouts", alfalfa: "sprouts", cheese: "soft cheese", queso: "soft cheese", eggs: "shell eggs", egg: "shell eggs",
  fish: "finfish", tuna: "finfish", salmon: "finfish", finfish: "finfish",
};

const HAZARDS = ["E. coli O157:H7", "E. coli", "Salmonella", "Listeria monocytogenes", "Listeria", "Cyclospora", "Hepatitis A", "Norovirus", "undeclared allergen"];

const Extracted = z.object({
  commodity: z.string(),
  productText: z.string(),
  firm: z.string().nullable(),
  lotCodes: z.array(z.string()),
  dateFrom: z.string().nullable(),
  dateTo: z.string().nullable(),
  hazard: z.string().nullable(),
  recallClass: z.enum(["I", "II", "III"]).nullable(),
  uncertainty: z.array(z.string()),
});
type Extracted = z.infer<typeof Extracted>;

const LOT_PATTERNS = [/\bGR\d{1,2}-\d{5}-[A-Z0-9]{1,3}\b/gi, /\bPK-?\d{6}-?\d{1,3}\b/gi];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function isoDates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) out.push(m[0]);
  for (const m of text.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(20\d{2})\b/gi)) {
    out.push(`${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  }
  return out.sort();
}

/** Deterministic reading of a notice: used when no model answers, and as the check on what a model claims. */
export function ruleScope(text: string): Extracted {
  const lower = text.toLowerCase();
  const codeInfo = text.match(/code info(?:rmation)?[:\s]+([^\n]+)/i)?.[1] ?? "";
  const generic = [...codeInfo.matchAll(/\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z][A-Z0-9-]{5,}\b/g)].map((m) => m[0]).filter((c) => !/^[A-Z]-\d+-\d{4}$/.test(c));
  const lotCodes = [...new Set([...LOT_PATTERNS.flatMap((re) => [...text.matchAll(re)].map((m) => m[0].toUpperCase())), ...generic])];
  const word = Object.keys(ALIASES).find((w) => new RegExp(`\\b${w}\\b`).test(lower));
  const between = text.match(/between\s+(.+?)\s+and\s+(.+?(?:20\d{2}|\d{2}-\d{2}))/i);
  const dates = between ? [...isoDates(between[1]), ...isoDates(between[2])].sort() : isoDates(codeInfo || text);
  const firm = text.match(/recalling firm[:\s]+([^\n.;]+)/i)?.[1]?.trim() ?? text.match(/\b([A-Z][\w&' ]+ (?:Farms?|Packing|Produce|Growers|Fresh)(?: (?:Inc|LLC|Co)\.?)?)/)?.[1] ?? null;
  const cls = text.match(/class\s+(III|II|I)\b/i)?.[1]?.toUpperCase() as Extracted["recallClass"] | undefined;
  const uncertainty: string[] = [];
  if (!word) uncertainty.push("commodity not recognised in the notice");
  if (!lotCodes.length && dates.length < 2) uncertainty.push("no lot codes and no date window: scope cannot be bounded");
  return {
    commodity: word ? ALIASES[word] : "unknown",
    productText: text.match(/product(?: description)?[:\s]+([^\n]+)/i)?.[1]?.trim().slice(0, 200) ?? text.slice(0, 120),
    firm,
    lotCodes,
    dateFrom: lotCodes.length ? null : dates[0] ?? null,
    dateTo: lotCodes.length ? null : dates.at(-1) ?? null,
    hazard: HAZARDS.find((h) => lower.includes(h.toLowerCase())) ?? null,
    recallClass: cls ?? null,
    uncertainty,
  };
}

const SYSTEM = `You read food recall and outbreak notices for the food-safety lead of a produce distributor.
Extract the recall scope using ONLY what the notice says. Never invent lot codes, firms or dates.
If the notice bounds the recall by harvest or pack dates instead of lot codes, put that window in dateFrom/dateTo (ISO yyyy-mm-dd).
commodity must be one of: ${COMMODITIES.join(", ")}, or "unknown".
List anything ambiguous in uncertainty.
Reply with one JSON object: {"commodity","productText","firm","lotCodes","dateFrom","dateTo","hazard","recallClass","uncertainty"}.`;

/** IntakeAgent: notice text in, bounded recall scope out. A model reads it; rules check every lot code it claims. */
export async function intake(ctx: AgentContext, notice: string): Promise<RecallScope> {
  const rules = ruleScope(notice);
  const res = await ctx.models.chat({
    agent: "IntakeAgent", lane: "reason", purpose: "extract recall scope from the notice", system: SYSTEM, user: notice,
    schema: Extracted, ruleFallback: () => rules, targetAgent: "SourceMapperAgent",
  });
  const scope = res.json;
  const uncertainty = [...scope.uncertainty];

  // A lot code the notice does not contain is not in scope, whatever the model says.
  const inText = new Set(rules.lotCodes);
  const kept = scope.lotCodes.map((c) => c.toUpperCase()).filter((c) => inText.has(c) || notice.toUpperCase().includes(c));
  const dropped = scope.lotCodes.filter((c) => !kept.includes(c.toUpperCase()));
  if (dropped.length) uncertainty.push(`ignored lot codes not present in the notice: ${dropped.join(", ")}`);
  for (const c of rules.lotCodes) if (!kept.includes(c)) kept.push(c);
  const commodity = (COMMODITIES as readonly string[]).includes(scope.commodity) ? scope.commodity : rules.commodity;

  const result: RecallScope = {
    noticeId: `N-${createHash("sha256").update(notice).digest("hex").slice(0, 10)}`,
    commodity,
    productText: scope.productText || rules.productText,
    firm: scope.firm ?? rules.firm ?? undefined,
    lotCodes: kept,
    dateFrom: scope.dateFrom ?? rules.dateFrom ?? undefined,
    dateTo: scope.dateTo ?? rules.dateTo ?? undefined,
    hazard: scope.hazard ?? rules.hazard ?? undefined,
    recallClass: scope.recallClass ?? rules.recallClass ?? undefined,
    uncertainty: [...new Set([...uncertainty, ...rules.uncertainty])],
  };
  ctx.trace.emit({
    agent_name: "IntakeAgent", action: "scope.ready", input_summary: `notice ${result.noticeId}`,
    output_summary: `${result.commodity}; ${result.lotCodes.length} lot codes; window ${result.dateFrom ?? "-"}..${result.dateTo ?? "-"}`,
    target_agent: "SourceMapperAgent", model: res.model, status: result.uncertainty.length ? "needs_revision" : "success",
    detail: { scope: result },
  });
  return result;
}
