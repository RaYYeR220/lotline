/**
 * Guard: five independent layers, each returning pass / warn / block with a reason.
 *
 *   1. injection   known patterns, role drift, out-of-band tool references, optional model check;
 *                  a second pass over retrieved snippets (context poisoning)
 *   2. policy      registry roles/surfaces plus declarative per-intent pack rules
 *   3. scope       session drift and high-risk bursts (advisory: they lift, never block)
 *   4. pii         redact (default) or block by data class
 *   5. rate limit  per user + intent + surface, per minute
 *
 * Reduction: any block -> "block"; any warn -> lift the intent's base risk by one band;
 * a high-risk intent at medium/high carries a user-confirm approval requirement.
 */
import { cleanText } from "./text.ts";
import { matchesParams, type Channel, type ComposedPack, type Threat } from "./packs.ts";
import type { ApprovalSpec, GuardResult, Intent, Redaction, RiskClass, RiskFlag, SessionContext, UserRef } from "./types.ts";

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

export interface InjectionMatch {
  id: string;
  threat: Threat;
  method: string;
  weight: number;
}

export interface InjectionScan {
  score: number;
  threat: Threat | null;
  method: string | null;
  matches: InjectionMatch[];
}

const TOOL_REF = /\b(?:use|call|invoke|run|execute|trigger|open|access|hit)\s+(?:the\s+)?([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z][a-z0-9]*(?:\.[a-z0-9_]+)+)\b/gi;
const SENSITIVE_TOOL = /admin|internal|root|sudo|shell|exec|debug|override|secret|privileg/i;

/** noisy-OR: independent signals reinforce each other without ever exceeding 1. */
export function combine(weights: number[]): number {
  return 1 - weights.reduce((acc, w) => acc * (1 - Math.max(0, Math.min(1, w))), 1);
}

/**
 * Score one text for injection. `knownTool` says whether an identifier is a capability or tool
 * reachable in this deployment; anything else the text asks to "use"/"call" is out of band.
 */
export function scanInjection(text: string, pack: ComposedPack, channel: Channel, knownTool: (id: string) => boolean = () => false): InjectionScan {
  // Scan the raw text (control characters are themselves evidence) and a normalised copy
  // (so zero-width splits and compatibility forms cannot hide a known phrase).
  const views = [text, cleanText(text)];
  const found = new Map<string, InjectionMatch>();
  for (const pat of pack.patterns) {
    if (pat.channels && !pat.channels.includes(channel)) continue;
    if (views.some((v) => pat.re.test(v))) found.set(pat.id, { id: pat.id, threat: pat.threat, method: pat.method, weight: pat.weight });
  }
  for (const m of views[1]!.matchAll(TOOL_REF)) {
    const ref = m[1]!.toLowerCase();
    if (knownTool(ref)) continue;
    const weight = SENSITIVE_TOOL.test(ref) ? 0.9 : 0.8;
    const prev = found.get("tool.out-of-band");
    if (!prev || prev.weight < weight) found.set("tool.out-of-band", { id: "tool.out-of-band", threat: "tool_abuse", method: "tool-ref", weight });
  }
  const matches = [...found.values()].sort((a, b) => b.weight - a.weight);
  return {
    score: Math.round(combine(matches.map((m) => m.weight)) * 1000) / 1000,
    threat: matches[0]?.threat ?? null,
    method: matches[0]?.method ?? null,
    matches,
  };
}

// ---------------------------------------------------------------------------
// PII / sensitivity
// ---------------------------------------------------------------------------

const PII: { kind: string; re: RegExp; check?: (s: string) => boolean }[] = [
  { kind: "credential", re: /\b(?:sk|pk|rk|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{12,}\b|\bAKIA[0-9A-Z]{16}\b|\b(?:password|passwd|pwd|api[_-]?key|secret|token)\s*[:=]\s*\S+/gi },
  { kind: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "phone", re: /(?<![\w-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g },
  { kind: "credit-card", re: /\b(?:\d[ -]?){13,19}\b/g, check: luhn },
];

function luhn(s: string): boolean {
  const digits = s.replace(/\D/g, "");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

export function findPii(text: string): Redaction[] {
  const out: Redaction[] = [];
  for (const { kind, re, check } of PII) {
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (check && !check(m[0])) continue;
      if (out.some((r) => start < r.end && end > r.start)) continue;
      out.push({ kind, start, end, replacement: `[REDACTED:${kind}]` });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function redact(text: string, redactions: Redaction[]): string {
  let s = text;
  for (const r of [...redactions].sort((a, b) => b.start - a.start)) s = s.slice(0, r.start) + r.replacement + s.slice(r.end);
  return s;
}

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------

const RANK: RiskClass[] = ["low", "medium", "high"];
const lift = (r: RiskClass): RiskClass => RANK[Math.min(2, RANK.indexOf(r) + 1)]!;
const maxRisk = (a: RiskClass, b: RiskClass): RiskClass => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);
const allows = (list: string[], value: string | undefined) => list.includes("*") || (value !== undefined && list.includes(value));

export interface GuardIntent {
  intent: Intent;
  parameters: Record<string, unknown>;
  /** Range/enum problems found while binding parameters. */
  problems: string[];
}

export interface GuardInput {
  prompt: string;
  user: UserRef;
  surface: string;
  intents: GuardIntent[];
  context?: SessionContext;
  /** Result of the optional model lane for injection, merged into the pattern score. */
  modelInjection?: { score: number; kind?: string };
  /** Count this request against rate limits and burst windows (decide does; previews do not). */
  record?: boolean;
}

export class GuardStack {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private pack: ComposedPack,
    private readonly knownTool: (id: string) => boolean,
    private readonly clock: () => Date,
  ) {}

  setPack(pack: ComposedPack): void {
    this.pack = pack;
  }

  /** Denied capabilities lower an intent's score in Sense (riskPenalty) and block in Guard. */
  deniedCapabilities(intent: Intent, user: UserRef): string[] {
    return this.pack.capabilityDeny
      .filter((d) => allows(d.roles, user.role))
      .flatMap((d) => intent.capabilities.filter((c) => d.capabilities.includes(c)));
  }

  evaluate(input: GuardInput): GuardResult {
    const flags: RiskFlag[] = [];
    const approvalsRequired: ApprovalSpec[] = [];
    const block = (f: Omit<RiskFlag, "severity">) => flags.push({ ...f, severity: "block" });
    const warn = (f: Omit<RiskFlag, "severity">) => flags.push({ ...f, severity: "warn" });

    // 1. Injection: the raw prompt, then every retrieved snippet.
    const scan = scanInjection(input.prompt, this.pack, "prompt", this.knownTool);
    const modelScore = input.modelInjection?.score ?? 0;
    const score = Math.round(combine([scan.score, modelScore]) * 1000) / 1000;
    const threat = modelScore > scan.score ? (input.modelInjection?.kind ?? scan.threat ?? "instruction_override") : scan.threat;
    const evidence = [...scan.matches.map((m) => m.id), ...(modelScore > 0 ? [`model:${modelScore}`] : [])];
    const injFlag = { kind: `injection.${threat}`, layer: "injection" as const, method: modelScore > scan.score ? "model" : (scan.method ?? "pattern"), score, evidence };
    if (score >= this.pack.blockAt) block({ ...injFlag, detail: `injection score ${score} >= ${this.pack.blockAt}` });
    else if (score >= this.pack.warnAt) warn({ ...injFlag, detail: `injection score ${score}` });
    (input.context?.snippets ?? []).forEach((snippet, i) => {
      const s = scanInjection(snippet, this.pack, "snippet", this.knownTool);
      const f = { kind: "injection.context_poisoning", layer: "injection" as const, method: s.method ?? "pattern", score: s.score, evidence: [`snippet[${i}]`, ...s.matches.map((m) => m.id)] };
      if (s.score >= this.pack.snippetBlockAt) block({ ...f, detail: `retrieved snippet ${i} carries instructions (score ${s.score})` });
      else if (s.score >= this.pack.warnAt) warn({ ...f, detail: `retrieved snippet ${i} looks instruction-like` });
    });

    // 2. Policy gate.
    for (const { intent, parameters, problems } of input.intents) {
      if (!allows(intent.roles, input.user.role)) block({ kind: "policy.role", layer: "policy", detail: `role "${input.user.role ?? "none"}" may not invoke ${intent.id}` });
      if (!allows(intent.surfaces, input.surface)) block({ kind: "policy.surface", layer: "policy", detail: `${intent.id} is not allowed on surface "${input.surface}"` });
      for (const cap of this.deniedCapabilities(intent, input.user)) block({ kind: "policy.capability", layer: "policy", detail: `capability ${cap} is denied for role "${input.user.role}"` });
      for (const rule of this.pack.intents[intent.id] ?? []) {
        if (rule.allow?.roles && !allows(rule.allow.roles, input.user.role)) block({ kind: "policy.role", layer: "policy", detail: `pack rule: role "${input.user.role}" may not invoke ${intent.id}` });
        if (rule.allow?.surfaces && !allows(rule.allow.surfaces, input.surface)) block({ kind: "policy.surface", layer: "policy", detail: `pack rule: ${intent.id} not allowed on "${input.surface}"` });
        for (const [name, bound] of Object.entries(rule.allow?.params ?? {})) {
          const v = parameters[name];
          if (typeof v === "number" && ((bound.max !== undefined && v > bound.max) || (bound.min !== undefined && v < bound.min))) {
            block({ kind: "policy.param-bounds", layer: "policy", detail: `${intent.id}: ${name}=${v} outside allowed bounds` });
          }
        }
        for (const combo of rule.deny?.paramCombinations ?? []) {
          if (matchesParams(parameters, combo)) block({ kind: "policy.denied-combination", layer: "policy", detail: `${intent.id}: parameter combination ${JSON.stringify(combo)} is denied` });
        }
        for (const cond of rule.requireApproval ?? []) {
          if (matchesParams(parameters, cond)) approvalsRequired.push({ kind: "operator-review", reason: `${intent.id}: ${JSON.stringify(cond)} requires review` });
        }
      }
      for (const problem of problems) warn({ kind: "policy.param-range", layer: "policy", detail: `${intent.id}: ${problem}` });
    }

    // 3. Scope: advisory flags that lift the level.
    const now = this.clock().getTime();
    const primary = input.intents[0]?.intent;
    const recent = input.context?.recentIntents ?? [];
    if (primary?.riskClass === "high" && recent.length && !recent.some((id) => id.split(".")[0] === primary.category)) {
      warn({ kind: "scope.drift", layer: "scope", detail: `high-risk ${primary.id} after unrelated session activity` });
    }
    const highRisk = input.intents.some((g) => g.intent.riskClass === "high");
    const burstKey = `burst|${input.user.id}`;
    const burst = this.window(burstKey, now, 10 * 60_000);
    if (highRisk && burst.length >= 3) warn({ kind: "scope.burst", layer: "scope", detail: `${burst.length} high-risk requests in 10 minutes` });

    // 4. PII / sensitivity.
    const redactions = findPii(input.prompt);
    for (const kind of new Set(redactions.map((r) => r.kind))) {
      const f = { kind: `pii.${kind}`, layer: "pii" as const, detail: `${kind} found in prompt` };
      if (this.pack.piiAction === "block") block(f);
      else warn(f);
    }

    // 5. Rate limit, per user + intent + surface.
    for (const { intent } of input.intents) {
      const key = `rate|${input.user.id}|${intent.id}|${input.surface}`;
      const hits = this.window(key, now, 60_000);
      const limit = intent.riskClass === "high" ? this.pack.rateLimit.highRiskPerMinute : this.pack.rateLimit.perMinute;
      if (hits.length >= limit) block({ kind: "rate-limit", layer: "rate-limit", detail: `${intent.id}: ${hits.length} requests in the last minute (limit ${limit})` });
    }

    const blocked = flags.find((f) => f.severity === "block");
    if (!blocked && input.record !== false) {
      for (const { intent } of input.intents) this.window(`rate|${input.user.id}|${intent.id}|${input.surface}`, now, 60_000).push(now);
      if (highRisk) burst.push(now);
    }

    let level: GuardResult["level"];
    if (blocked) {
      level = "block";
    } else {
      // PII redaction is handled by redaction itself; it does not make the action riskier.
      const lifting = flags.some((f) => f.severity === "warn" && f.layer !== "pii");
      const base = input.intents.reduce<RiskClass>((acc, g) => maxRisk(acc, g.intent.riskClass), "low");
      level = lifting ? lift(base) : base;
      if (highRisk && level !== "low") approvalsRequired.unshift({ kind: "user-confirm", reason: "high-risk intent" });
    }
    return {
      level,
      flags,
      redactions,
      redactedPrompt: redact(input.prompt, redactions),
      approvalsRequired: dedupeApprovals(approvalsRequired),
      ...(blocked ? { reason: `${blocked.kind}: ${blocked.detail}` } : {}),
    };
  }

  private window(key: string, now: number, spanMs: number): number[] {
    const list = (this.windows.get(key) ?? []).filter((t) => now - t < spanMs);
    this.windows.set(key, list);
    return list;
  }
}

function dedupeApprovals(list: ApprovalSpec[]): ApprovalSpec[] {
  const seen = new Set<string>();
  return list.filter((a) => (seen.has(a.kind) ? false : (seen.add(a.kind), true)));
}
