/**
 * Policy packs: versioned bundles of injection patterns, thresholds, per-intent rules,
 * capability scoping, PII handling and rate limits. Packs compose left to right; the
 * composed version tag ("default@1+adversarial-tight@1") is stamped on every contract.
 *
 * Injection scoring: each matched pattern contributes its weight and the matches combine
 * as a noisy-OR, score = 1 - prod(1 - w). A pack blocks at `blockAt`, warns at `warnAt`.
 * Retrieved snippets / partner notes are data, never instructions, so they are judged
 * against the stricter `snippetBlockAt`.
 */
import { readFileSync } from "node:fs";

export type Threat =
  | "instruction_override"
  | "role_confusion"
  | "data_exfiltration"
  | "tool_abuse"
  | "privilege_escalation"
  | "obfuscation"
  | "context_poisoning";

export type Channel = "prompt" | "snippet";

export interface InjectionPattern {
  id: string;
  threat: Threat;
  method: "pattern" | "role-drift" | "tool-ref";
  weight: number;
  re: RegExp;
  /** Channels the pattern applies to (default: both). */
  channels?: Channel[];
}

export interface ParamCondition {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  eq?: unknown;
  in?: unknown[];
}

export interface IntentPolicy {
  allow?: { roles?: string[]; surfaces?: string[]; params?: Record<string, { min?: number; max?: number }> };
  deny?: { paramCombinations?: Record<string, unknown | ParamCondition>[] };
  requireApproval?: Record<string, unknown | ParamCondition>[];
}

export interface PolicyPack {
  id: string;
  version: number;
  injection?: { blockAt?: number; warnAt?: number; snippetBlockAt?: number; patterns?: InjectionPattern[] };
  intents?: Record<string, IntentPolicy>;
  /** e.g. { roles: ["viewer"], capabilities: ["email.send", "world.assert"] } */
  capabilityDeny?: { roles: string[]; capabilities: string[] }[];
  pii?: { action?: "redact" | "block" };
  rateLimit?: { perMinute?: number; highRiskPerMinute?: number };
}

/** A pack as it may appear in a JSON file: patterns carry their regex as a string. */
export interface PackFile extends Omit<PolicyPack, "injection"> {
  injection?: Omit<NonNullable<PolicyPack["injection"]>, "patterns"> & {
    patterns?: (Omit<InjectionPattern, "re"> & { pattern: string; flags?: string })[];
  };
}

const p = (id: string, threat: Threat, weight: number, re: RegExp, method: InjectionPattern["method"] = "pattern", channels?: Channel[]): InjectionPattern => ({
  id,
  threat,
  weight,
  re,
  method,
  channels,
});

const OVERRIDE_TARGET_STRONG = "(?:instructions?|prompts?|directives?|guidance|rules|guardrails?|safeguards?|system\\s+(?:prompt|message))";
const OVERRIDE_TARGET_SOFT = "(?:polic(?:y|ies)|guidelines?|constraints?|restrictions?|context)";

/** General-purpose patterns: known injection strings, role confusion, embedded control, exfiltration. */
const DEFAULT_PATTERNS: InjectionPattern[] = [
  p("override.ignore-instructions", "instruction_override", 0.9, new RegExp(`\\b(?:ignore|disregard|forget|override|bypass)\\b[^\\n]{0,40}?\\b${OVERRIDE_TARGET_STRONG}\\b`, "i")),
  p("override.ignore-policy", "instruction_override", 0.6, new RegExp(`\\b(?:ignore|disregard|forget|override|bypass)\\s+(?:all\\s+|any\\s+|the\\s+|your\\s+|my\\s+|these\\s+|those\\s+)?${OVERRIDE_TARGET_SOFT}\\b`, "i")),
  p("override.ignore-previous", "instruction_override", 0.8, /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|everything\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding|everything)\b/i),
  p("override.disregard-party", "instruction_override", 0.85, /\b(?:ignore|disregard)\s+(?:the\s+)?(?:user|operator|developer|system|assistant)\b/i),
  p("override.new-instructions", "instruction_override", 0.6, /\b(?:new|updated|real|actual|true)\s+(?:instructions?|system\s+prompt|directives?|orders)\b/i),
  p("role.you-are-now", "role_confusion", 0.8, /\byou\s+are\s+now\b/i, "role-drift"),
  p("role.privileged-persona", "role_confusion", 0.85, /\b(?:you\s+are|you're|act\s+as|pretend\s+(?:to\s+be|you\s+are)|roleplay\s+as|behave\s+as|impersonate)\s+(?:an?\s+|the\s+)?(?:system|admin(?:istrator)?|root|superuser|developer|database\s+admin\w*|dba|sudo|operator|unrestricted|jailbroken|dan)\b/i, "role-drift"),
  p("role.persona", "role_confusion", 0.5, /\b(?:you\s+are|act\s+as|pretend\s+to\s+be|roleplay\s+as)\s+(?:an?|the)\s+\w+/i, "role-drift"),
  p("role.mode", "role_confusion", 0.85, /\b(?:developer|dev|god|debug|admin|unrestricted|jailbreak|jailbroken|dan|sudo|root)\s+mode\b/i, "role-drift"),
  p("control.chat-markup", "role_confusion", 0.95, /<\/?\s*(?:system|user|assistant|human|im_start|im_end|tool|function)\s*>|<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?(?:INST|SYS)\]|<<\/?SYS>>/i),
  p("control.role-prefix", "role_confusion", 0.7, /(?:^|\n|<!--|\[|\()\s*(?:system|assistant|developer)\s*:/i),
  p("exfil.secrets", "data_exfiltration", 0.8, /\b(?:reveal|print|show|dump|leak|expose|output|display|list|share|send|give|tell|return|exfiltrate)\b[^\n]{0,40}?\b(?:credentials?|passwords?|passwd|secrets?|api[\s_-]?keys?|access[\s_-]?keys?|private[\s_-]?keys?|tokens?|system\s+prompt|env(?:ironment)?\s*var(?:iable)?s?|\.env|ssh\s+keys?)\b/i),
  p("exfil.bulk-records", "data_exfiltration", 0.5, /\b(?:email|send|forward|post|upload|export)\b[^\n]{0,60}?\b(?:every|all)\s+(?:customers?|users?|accounts?|contacts?)\b[^\n]{0,40}?\b(?:records?|data|pii|details|crm)\b/i),
  p("exfil.external-address", "data_exfiltration", 0.6, /\b(?:pii|personal\s+data|records|credentials|customer\s+data)\b[^\n]{0,40}?\bto\s+[\w.+-]+@[\w-]+\.[\w.]+/i),
  p("privilege.grant-admin", "privilege_escalation", 0.75, /\b(?:grant|give|make|elevate|promote|escalate)\s+(?:me\s+|us\s+|myself\s+|this\s+user\s+|my\s+account\s+)?(?:an?\s+)?(?:admin(?:istrator)?|root|superuser|owner|sudo|full\s+access|elevated|privileged)\b/i),
  p("tool.shell", "tool_abuse", 0.85, /\brm\s+-rf\b|\bsudo\s+\w|\/etc\/(?:passwd|shadow)\b|\bcurl\s[^|\n]*\|\s*(?:ba)?sh\b|\bos\.system\b|\bsubprocess\b|\b(?:run|execute|use)\s+(?:a\s+|the\s+)?(?:shell|terminal|bash|command\s+line)\b/i),
  p("destructive.drop-table", "tool_abuse", 0.6, /\b(?:drop|truncate)\s+(?:the\s+)?(?:\w+\s+)?(?:table|database|schema|collection)s?\b/i),
  p("obfuscation.bidi", "obfuscation", 0.6, /[‪-‮⁦-⁩]|\\u(?:202[a-e]|206[6-9])|&#x?(?:202e|8238);/i),
  p("obfuscation.zero-width", "obfuscation", 0.4, /[​-‍⁠﻿]|\\u(?:200[b-d]|feff)/i),
  p("hidden.comment", "context_poisoning", 0.5, /<!--[^>]*[a-z]{3}[\s\S]*?-->/i),
  p("authority.markdown", "instruction_override", 0.35, /(?:^|\n)\s*#{1,6}\s*(?:important|urgent|attention|override|admin)\b/i),
  p("addressed.to-model", "instruction_override", 0.7, /\b(?:note|message|instructions?|memo)\s+(?:to|for)\s+(?:the\s+)?(?:ai|assistant|model|agent|llm|bot|chatbot|system|automation)\b|\b(?:ai|assistant|llm|chatbot)\s*[,:]\s+(?:please\s+)?(?:ignore|mark|set|clear|approve|delete|send|grant|skip)\b/i),
];

/** Hardened posture for hostile surfaces: the eval runner composes it with `default`. */
const ADVERSARIAL_PATTERNS: InjectionPattern[] = [
  p("override.from-now-on", "instruction_override", 0.4, /\bfrom\s+now\s+on\b/i),
  p("role.unrestricted", "role_confusion", 0.45, /\b(?:unrestricted|unfiltered|uncensored|no\s+restrictions|without\s+(?:any\s+)?restrictions)\b/i, "role-drift"),
  p("exfil.reveal-hidden", "data_exfiltration", 0.5, /\b(?:reveal|print|repeat|output)\s+(?:your\s+|the\s+)?(?:hidden|internal|initial|original)\b/i),
];

/**
 * Lotline: partner notes, BOL text and other partner data must never steer a recall action.
 * These only apply to the snippet channel; an operator typing "clear store 3" is a request,
 * the same words inside a partner note are an injection attempt.
 */
const LOTLINE_PATTERNS: InjectionPattern[] = [
  p("recall.status-directive", "context_poisoning", 0.5, /\b(?:mark|set|flag|treat|record|consider|list|report|update)\b[^\n]{0,40}?\b(?:as\s+)?(?:clear(?:ed)?|safe|released|approved|unaffected|not\s+affected|resolved|compliant)\b/i, "pattern", ["snippet"]),
  p("recall.skip-control", "context_poisoning", 0.5, /\b(?:skip|bypass|waive|cancel|lift|remove|release|drop)\s+(?:the\s+|this\s+|that\s+|any\s+)?(?:hold|recall|quarantine|check|verification|review|approval)s?\b/i, "pattern", ["snippet"]),
  p("recall.do-not-act", "context_poisoning", 0.5, /\b(?:do\s+not|don['’]t|never)\s+(?:pull|hold|recall|notify|escalate|quarantine|report|flag)\b/i, "pattern", ["snippet"]),
  p("recall.clear-it", "context_poisoning", 0.5, /\b(?:clear|release|unhold|approve)\s+(?:it|this|that|them|the\s+(?:lot|store|location|shipment|pallet|hold)|store\s*#?\d+)\b/i, "pattern", ["snippet"]),
];

export const BUILTIN_PACKS: Record<string, PolicyPack> = {
  default: {
    id: "default",
    version: 1,
    injection: { blockAt: 0.7, warnAt: 0.35, snippetBlockAt: 0.55, patterns: DEFAULT_PATTERNS },
    pii: { action: "redact" },
    rateLimit: { perMinute: 30, highRiskPerMinute: 5 },
  },
  "adversarial-tight": {
    id: "adversarial-tight",
    version: 1,
    injection: { blockAt: 0.55, warnAt: 0.3, snippetBlockAt: 0.45, patterns: ADVERSARIAL_PATTERNS },
  },
  lotline: {
    id: "lotline",
    version: 1,
    injection: { snippetBlockAt: 0.55, patterns: LOTLINE_PATTERNS },
  },
};

export type PackSpec = string | PolicyPack | (string | PolicyPack)[] | undefined;

export interface ComposedPack {
  versionTag: string;
  blockAt: number;
  warnAt: number;
  snippetBlockAt: number;
  patterns: InjectionPattern[];
  intents: Record<string, IntentPolicy[]>;
  capabilityDeny: { roles: string[]; capabilities: string[] }[];
  piiAction: "redact" | "block";
  rateLimit: { perMinute: number; highRiskPerMinute: number };
}

function fromFile(file: string): PolicyPack {
  const raw = JSON.parse(readFileSync(file, "utf8")) as PackFile;
  return {
    ...raw,
    injection: raw.injection && {
      ...raw.injection,
      patterns: raw.injection.patterns?.map(({ pattern, flags, ...rest }) => ({ ...rest, re: new RegExp(pattern, (flags ?? "i").replace(/[gy]/g, "")) })),
    },
  };
}

function resolvePack(entry: string | PolicyPack): PolicyPack {
  if (typeof entry !== "string") return entry;
  if (BUILTIN_PACKS[entry]) return BUILTIN_PACKS[entry];
  if (/\.json$/i.test(entry)) return fromFile(entry);
  throw new Error(`unknown policy pack "${entry}" (built in: ${Object.keys(BUILTIN_PACKS).join(", ")}; or a .json pack file)`);
}

/** Compose packs left to right: thresholds take the strictest value, rules accumulate. */
export function composePacks(spec: PackSpec): ComposedPack {
  const entries = spec === undefined ? ["default"] : Array.isArray(spec) ? spec : [spec];
  const packs = entries.map(resolvePack);
  const out: ComposedPack = {
    versionTag: packs.map((x) => `${x.id}@${x.version}`).join("+"),
    blockAt: 1,
    warnAt: 1,
    snippetBlockAt: 1,
    patterns: [],
    intents: {},
    capabilityDeny: [],
    piiAction: "redact",
    rateLimit: { perMinute: Infinity, highRiskPerMinute: Infinity },
  };
  const byId = new Map<string, InjectionPattern>();
  for (const pack of packs) {
    const inj = pack.injection ?? {};
    if (inj.blockAt !== undefined) out.blockAt = Math.min(out.blockAt, inj.blockAt);
    if (inj.warnAt !== undefined) out.warnAt = Math.min(out.warnAt, inj.warnAt);
    if (inj.snippetBlockAt !== undefined) out.snippetBlockAt = Math.min(out.snippetBlockAt, inj.snippetBlockAt);
    for (const pat of inj.patterns ?? []) byId.set(pat.id, pat);
    for (const [intent, rule] of Object.entries(pack.intents ?? {})) (out.intents[intent] ??= []).push(rule);
    out.capabilityDeny.push(...(pack.capabilityDeny ?? []));
    if (pack.pii?.action === "block") out.piiAction = "block";
    if (pack.rateLimit?.perMinute !== undefined) out.rateLimit.perMinute = Math.min(out.rateLimit.perMinute, pack.rateLimit.perMinute);
    if (pack.rateLimit?.highRiskPerMinute !== undefined) out.rateLimit.highRiskPerMinute = Math.min(out.rateLimit.highRiskPerMinute, pack.rateLimit.highRiskPerMinute);
  }
  // A pack that only adds patterns still needs sane thresholds.
  if (out.blockAt === 1) out.blockAt = BUILTIN_PACKS.default!.injection!.blockAt!;
  if (out.warnAt === 1) out.warnAt = BUILTIN_PACKS.default!.injection!.warnAt!;
  if (out.snippetBlockAt === 1) out.snippetBlockAt = Math.min(out.blockAt, BUILTIN_PACKS.default!.injection!.snippetBlockAt!);
  out.patterns = [...byId.values()];
  return out;
}

/** Does a parameter set match a declarative condition map ({ channel: "call", count: { gt: 5 } })? */
export function matchesParams(params: Record<string, unknown>, cond: Record<string, unknown>): boolean {
  return Object.entries(cond).every(([key, want]) => {
    const have = params[key];
    if (want && typeof want === "object" && !Array.isArray(want)) {
      const c = want as ParamCondition;
      const n = typeof have === "number" ? have : NaN;
      if (c.gt !== undefined && !(n > c.gt)) return false;
      if (c.gte !== undefined && !(n >= c.gte)) return false;
      if (c.lt !== undefined && !(n < c.lt)) return false;
      if (c.lte !== undefined && !(n <= c.lte)) return false;
      if (c.eq !== undefined && have !== c.eq) return false;
      if (c.in !== undefined && !c.in.includes(have)) return false;
      return true;
    }
    return have === want;
  });
}
