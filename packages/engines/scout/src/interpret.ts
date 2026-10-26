/**
 * Interpret: bind parameters and entity references to the chosen intent, and decide
 * whether Scout must ask before acting. Interpret never changes scores.
 *
 * Clarification triggers (any one):
 *   reference-unresolved  "the thing we talked about" with no session turns to resolve it
 *   underspecified        a vague verb ("handle", "deal with") or a bare entity, nothing scored
 *   low-band              top-1 in 0.40-0.54
 *   tie                   top-1 and top-2 within 0.05 inside the Medium band
 *   params                a required parameter cannot be bound from the prompt
 *   high-risk             a high-risk intent below 0.95 confidence (a confirmation, see below)
 *
 * The first five mean "which intent did you mean?": no contract is issued. "high-risk" means
 * "confirm this": the contract is issued with a user-confirm approval requirement, so no
 * executor can act on it until the confirmation is recorded.
 */
import type { IntentRegistry } from "./registry.ts";
import { BANDS } from "./sense.ts";
import { slug, stem, type EntityMention } from "./text.ts";
import type { Clarification, EntityRef, Intent, IntentCandidate, ParamSpec, SessionContext } from "./types.ts";

export const HIGH_RISK_PROCEED = 0.95;
export const TIE_WINDOW = 0.05;
export const MAX_OPTIONS = 4;

// ---------------------------------------------------------------------------
// Parameter binding
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, dozen: 12,
};
const UNIT = "(?:minute|min|hour|day|week|month|quarter|year|am|pm|%)";
const STAGES = ["prospecting", "discovery", "qualification", "qualified", "demo", "proposal", "negotiation", "contracting", "closed-won", "closed-lost", "closed won", "closed lost"];
const DATE_RE =
  /\b(?:today|tomorrow|tonight|yesterday|(?:next|this|last)\s+(?:week|month|quarter|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?|in\s+\d+\s+(?:days?|weeks?|hours?))\b/i;
const PERIOD_RE = /\b(?:q[1-4](?:\s+\d{4})?|fy\s?\d{2,4}|h[12]\s+\d{4}|(?:this|last|next|past)\s+(?:\d+\s+)?(?:weeks?|months?|quarters?|years?|days?)|ytd|mtd)\b/i;
const DURATION_RE = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)[\s-](day|week|month|quarter|year)s?\b/i;
const TONE_RE = /\b(formal|casual|friendly|urgent|warm|concise|direct|apologetic)\b/i;

interface Money {
  value: number;
  start: number;
  end: number;
  cmp?: "min" | "max";
}

function moneyValues(text: string): Money[] {
  const out: Money[] = [];
  const re = /(over|above|more than|greater than|at least|exceeding|>=?|under|below|less than|at most|up to|<=?)?\s*\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|bn|b|thousand|million|billion)?\b/gi;
  for (const m of text.matchAll(re)) {
    const mult = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 }[(m[3] ?? "").toLowerCase()] ?? 1;
    const cmpWord = (m[1] ?? "").toLowerCase();
    const cmp = !cmpWord ? undefined : /over|above|more|greater|least|exceed|>/.test(cmpWord) ? "min" : "max";
    out.push({ value: Number(m[2]!.replace(/,/g, "")) * mult, start: m.index!, end: m.index! + m[0].length, cmp });
  }
  return out;
}

/** The first plain quantity that is not money, a date part, a unit or an identifier. */
function countValue(text: string, money: Money[]): number | undefined {
  const re = new RegExp(`\\b(\\d+|${Object.keys(NUMBER_WORDS).join("|")})\\b(?!\\s*-?\\s*${UNIT}s?\\b)(?![:.,]\\d)`, "gi");
  for (const m of text.matchAll(re)) {
    const at = m.index!;
    if (money.some((x) => at >= x.start && at < x.end)) continue;
    if (/(?:lot|store|#|no\.?|id|q|-|\$|:)\s*$/i.test(text.slice(Math.max(0, at - 6), at))) continue;
    const raw = m[1]!.toLowerCase();
    return /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  }
  return undefined;
}

function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z-]*/g) ?? []).map((w) => stem(w.replace(/-/g, "")));
}

/** Head object of the leading verb: "Send the launch announcement to all customers" -> "launch announcement". */
function objectPhrase(text: string): string | undefined {
  const m = /^\s*\w+\s+(?:me\s+|us\s+)?(?:the\s+|a\s+|an\s+|all\s+|my\s+|our\s+)?(.+?)\s*[.?!]*$/i.exec(text);
  const s = m?.[1]
    ?.replace(DATE_RE, "")
    .split(/\s+(?:to|for|from|about|with|by|on|at|in|and|then)\s+|[,;]/i)[0]
    ?.trim();
  return s ? s.slice(0, 80) : undefined;
}

export interface Binding {
  parameters: Record<string, unknown>;
  references: Record<string, EntityRef>;
  /** Range / enum violations; surfaced by the guard as warnings. */
  problems: string[];
  /** Required parameters that could not be bound. */
  missing: string[];
}

function entityKind(text: string, e: EntityMention): "person" | "account" | "entity" {
  const before = text.slice(Math.max(0, e.start - 12), e.start).toLowerCase();
  const after = text.slice(e.end, e.end + 16).toLowerCase();
  if (/\b(?:to|with|email|message|ping|cc|invite|tell|ask|call)\s+$/.test(before)) return "person";
  if (/\b(?:at|from|of)\s+$/.test(before) || /^['’]?s?\s*(?:deal|account|renewal|inbox|team|opportunity|contract|org|corp|inc)\b/.test(after)) return "account";
  return "entity";
}

export function bindParameters(intent: Intent, text: string, entities: EntityMention[], explicit: Record<string, unknown> = {}): Binding {
  const props = intent.parameters.properties ?? {};
  const parameters: Record<string, unknown> = {};
  const references: Record<string, EntityRef> = {};
  const problems: string[] = [];
  const money = moneyValues(text);
  const words = wordsOf(text);

  // References first: every proper noun becomes a stable, typed reference.
  const seen: Record<string, number> = {};
  for (const e of entities) {
    let kind: string = entityKind(text, e);
    if (kind === "person" && "recipient" in props) kind = "recipient";
    const n = (seen[kind] = (seen[kind] ?? 0) + 1);
    references[n === 1 ? kind : `${kind}${n}`] = { text: e.text, kind, id: `${kind}:${slug(e.text)}` };
  }
  const refOf = (...kinds: string[]) => Object.values(references).find((r) => kinds.includes(r.kind))?.text;

  for (const [name, spec] of Object.entries(props) as [string, ParamSpec][]) {
    let value: unknown;
    const type = spec.type ?? (spec.enum ? "enum" : "string");
    if (spec.enum) {
      const hits = spec.enum
        .map((v) => ({ v, at: words.indexOf(stem(String(v).toLowerCase().replace(/-/g, ""))) }))
        .filter((h) => h.at >= 0)
        .sort((a, b) => a.at - b.at);
      value = hits[0]?.v;
    } else if (type === "integer" || type === "number") {
      if (/min$/i.test(name)) value = money.find((m) => m.cmp === "min")?.value;
      else if (/max$/i.test(name)) value = money.find((m) => m.cmp === "max")?.value;
      else if (/^(?:value|amount|price|budget|arr|acv)$/i.test(name)) value = money[0]?.value;
      else value = countValue(text, money);
    } else if (type === "array") {
      const ents = entities.map((e) => e.text);
      if (ents.length >= 2) value = ents;
    } else if (/stage/i.test(name)) {
      const lower = text.toLowerCase();
      value = STAGES.find((s) => lower.includes(s))?.replace(" ", "-");
    } else if (/^(?:when|date|time|due|deadline)$/i.test(name)) {
      value = DATE_RE.exec(text)?.[0];
    } else if (/^(?:period|window|range|timeframe)$/i.test(name)) {
      value = PERIOD_RE.exec(text)?.[0];
    } else if (/horizon|duration/i.test(name)) {
      value = DURATION_RE.exec(text)?.[0];
    } else if (/account|company|org|customer/i.test(name)) {
      value = refOf("account") ?? refOf("entity");
    } else if (/recipient|person|contact|attendee/i.test(name)) {
      value = refOf("recipient", "person");
    } else if (/tone/i.test(name)) {
      value = TONE_RE.exec(text)?.[1]?.toLowerCase();
    } else if (/audience/i.test(name)) {
      value = /\bto\s+((?:all|every|our|the)\s+[\w\s-]+?)\s*[.?!]*$/i.exec(text)?.[1];
    } else if (/topic|subject|title|template|query/i.test(name)) {
      value = /\babout\s+(?:the\s+)?([\w\s-]+?)\s*[.?!]*$/i.exec(text)?.[1] ?? objectPhrase(text);
    }
    if (name in explicit) value = explicit[name];
    if (value === undefined || value === "") continue;

    if (typeof value === "number") {
      if (spec.minimum !== undefined && value < spec.minimum) problems.push(`${name}=${value} below minimum ${spec.minimum}`);
      if (spec.maximum !== undefined && value > spec.maximum) problems.push(`${name}=${value} above maximum ${spec.maximum}`);
    }
    if (spec.enum && !spec.enum.includes(value)) problems.push(`${name}=${String(value)} not in enum`);
    parameters[name] = value;
  }
  for (const [name, value] of Object.entries(explicit)) if (!(name in parameters)) parameters[name] = value;

  const missing = (intent.parameters.required ?? []).filter((p) => !(p in parameters));
  return { parameters, references, problems, missing };
}

// ---------------------------------------------------------------------------
// Clarification
// ---------------------------------------------------------------------------

const UNRESOLVED_REFERENCE = [
  /\b(?:the|that|this)\s+(?:thing|stuff|one|idea|issue|item|task|plan|matter)\s+(?:we|you|i)\s+(?:talked|spoke|discussed|chatted|mentioned|agreed|went\s+over)\b/i,
  /\b(?:what|everything)\s+(?:we|you|i)\s+(?:talked|spoke|discussed|agreed|went\s+over)\b/i,
  /\b(?:as|like)\s+(?:before|last\s+time|we\s+discussed|we\s+agreed|usual)\b/i,
  /\bthe\s+usual\b/i,
  /\bsame\s+as\s+(?:before|last\s+time|yesterday)\b/i,
  /\b(?:do|redo|repeat)\s+(?:it|that|this)\s+again\b/i,
];
const VAGUE_VERB = /\b(?:handle|deal\s+with|take\s+care\s+of|sort\s+out|fix|address|manage|tackle|look\s+at|work\s+on|figure\s+out|do\s+something\s+about|see\s+about)\b/i;

function label(intent: Intent): string {
  const first = intent.description.split(/[.;:(—]|\s-\s/)[0]!.trim();
  return (first || intent.id).slice(0, 70);
}

function options(registry: IntentRegistry, ids: string[]): Clarification["options"] {
  const out: Clarification["options"] = [];
  for (const id of ids) {
    const intent = registry.get(id);
    if (!intent || id === "GENERAL" || out.some((o) => o.intent === id)) continue;
    out.push({ label: label(intent), intent: id });
    if (out.length === MAX_OPTIONS) break;
  }
  return out;
}

export interface ClarifyInput {
  registry: IntentRegistry;
  text: string;
  candidates: IntentCandidate[];
  entities: EntityMention[];
  termCount: number;
  multi: boolean;
  context?: SessionContext;
  primary?: { intent: Intent; confidence: number; missing: string[] };
  /** Secondary intents of a multi-intent plan (checked for the high-risk confirmation). */
  secondary?: { intent: Intent; confidence: number }[];
}

export function clarify(input: ClarifyInput): Clarification | null {
  const { registry, text, candidates } = input;
  const top = candidates[0];
  const second = candidates[1];
  const topIds = candidates.filter((c) => c.score > 0).map((c) => c.intent);

  if (!input.context?.recentTurns?.length && UNRESOLVED_REFERENCE.some((re) => re.test(text))) {
    return {
      trigger: "reference-unresolved",
      reason: "the request points at an earlier conversation that is not in context",
      question: "Which earlier request do you mean? I don't have that conversation in context.",
      options: options(registry, topIds),
    };
  }

  const weak = !top || top.score < BANDS.medium;
  if (!input.multi && weak && (VAGUE_VERB.test(text) || (input.entities.length > 0 && input.termCount === 0))) {
    const subject = input.entities[0]?.text;
    const related = subject ? [...(registry.index.entityIntents.get(subject.toLowerCase()) ?? [])] : [];
    return {
      trigger: "underspecified",
      reason: "the action is not specific enough to pick an intent",
      question: subject ? `What would you like to do about ${subject}?` : "What would you like me to do?",
      options: options(registry, [...topIds, ...related]),
    };
  }

  if (!input.multi && top && top.band === "low") {
    return {
      trigger: "low-band",
      reason: `top intent ${top.intent} scored ${top.score} (Low band)`,
      question: "I'm not sure which of these you meant:",
      options: options(registry, topIds.slice(0, 3)),
    };
  }

  if (!input.multi && top && second && top.band === "medium" && top.score - second.score < TIE_WINDOW) {
    const [a, b] = options(registry, [top.intent, second.intent]);
    return {
      trigger: "tie",
      reason: `${top.intent} (${top.score}) and ${second.intent} (${second.score}) are within ${TIE_WINDOW}`,
      question: a && b ? `Did you want to ${a.label.toLowerCase()}, or ${b.label.toLowerCase()}?` : "Which did you mean?",
      options: options(registry, [top.intent, second.intent]),
    };
  }

  if (input.primary?.missing.length) {
    return {
      trigger: "params",
      reason: `required parameters not bound: ${input.primary.missing.join(", ")}`,
      question: `I need ${input.primary.missing.join(", ")} to do that.`,
      options: options(registry, [input.primary.intent.id]),
    };
  }

  const risky = [input.primary, ...(input.secondary ?? [])].find(
    (p) => p && p.intent.riskClass === "high" && p.confidence < HIGH_RISK_PROCEED,
  );
  if (risky) {
    return {
      trigger: "high-risk",
      reason: `${risky.intent.id} is high-risk and confidence ${risky.confidence} is below ${HIGH_RISK_PROCEED}`,
      question: `This is a high-risk action (${label(risky.intent).toLowerCase()}). Confirm before it runs?`,
      options: [{ label: "Yes, proceed", intent: risky.intent.id }],
    };
  }
  return null;
}

/** Later clauses that lean on earlier results run in order; independent ones run side by side. */
export function executionModeOf(spans: string[]): "single_step" | "parallel" | "plan_then_execute" {
  if (spans.length < 2) return "single_step";
  const dependent = spans.slice(1).some((s) => /\b(?:them|it|those|these|that|the results?|the numbers|the findings|summari[sz]ing)\b/i.test(s));
  return dependent ? "plan_then_execute" : "parallel";
}
