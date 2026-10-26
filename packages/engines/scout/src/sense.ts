/**
 * Sense: score every registered intent against the prompt and return top-k candidates.
 *
 *   finalScore(intent) = 0.40 lexical + 0.35 semantic + 0.20 contextual + 0.05 recency - riskPenalty
 *
 * Stage 1 (always on, pure rules) produces `lexical`. Stage 2 is an optional model lane
 * plugged in through Stage2Hooks.classify and produces `semantic`. When Stage 2 is absent or
 * fails, the weights are renormalised over what ran, so Stage 1's result stands on its own.
 * Context and recency come from the caller's session state and only ever lift a score.
 */
import { performance } from "node:perf_hooks";
import type { IntentRegistry, LexicalIndex } from "./registry.ts";
import { analyze, splitSpans, type Analysis } from "./text.ts";
import type { Band, IntentCandidate, SessionContext, Stage2Hooks } from "./types.ts";

export const WEIGHTS = { lexical: 0.4, semantic: 0.35, contextual: 0.2, recency: 0.05 } as const;
export const BANDS = { high: 0.8, medium: 0.55, low: 0.4 } as const;
export const TOP_K = 5;

/** Stage-1 blend: prompt coverage vs prototype similarity, then a lift for naming the intent itself. */
const LEXICAL = { coverage: 0.6, prototype: 0.4, idLift: 0.5, bigram: 0.5 } as const;

export function bandOf(score: number): Band {
  if (score >= BANDS.high) return "high";
  if (score >= BANDS.medium) return "medium";
  if (score >= BANDS.low) return "low";
  return "reject";
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** How informative a term is: 1 for a term only one intent knows (or none), lower as it spreads. */
function specificity(idx: LexicalIndex, term: string): number {
  const df = idx.df.get(term) ?? 0;
  if (df === 0) return 1;
  return Math.log(1 + idx.size / df) / Math.log(1 + idx.size);
}

type Vector = Map<string, number>;

function vectorOf(idx: LexicalIndex, terms: string[]): Vector {
  const v: Vector = new Map();
  for (const t of terms) v.set(t, specificity(idx, t));
  for (let i = 1; i < terms.length; i++) {
    const a = terms[i - 1]!;
    const b = terms[i]!;
    if (a !== b) v.set(`${a} ${b}`, LEXICAL.bigram * ((specificity(idx, a) + specificity(idx, b)) / 2));
  }
  return v;
}

const vectorCache = new WeakMap<LexicalIndex, Vector[]>();

/** Prototype vectors depend only on the registry, so they are built once per index. */
function prototypeVectors(idx: LexicalIndex): Vector[] {
  let v = vectorCache.get(idx);
  if (!v) {
    v = idx.prototypes.map((p) => vectorOf(idx, p.terms));
    vectorCache.set(idx, v);
  }
  return v;
}

function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, x] of a) {
    na += x * x;
    const y = b.get(k);
    if (y !== undefined) dot += x * y;
  }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface LexicalDetail {
  coverage: number;
  prototype: number;
  idMatch: number;
  lexical: number;
}

/**
 * Stage 1: weighted trigger scan over the full registry.
 *   coverage  - share of the prompt's (specificity-weighted) content explained by the intent's triggers
 *   prototype - best n-gram similarity to one of the intent's examples or its description
 *   idMatch   - the prompt names the intent's category and/or action ("draft ... email")
 */
export function lexicalScores(idx: LexicalIndex, terms: string[]): Map<string, LexicalDetail> {
  const unique = [...new Set(terms)];
  const total = unique.reduce((s, t) => s + specificity(idx, t), 0);
  const pv = vectorOf(idx, terms);
  const proto = new Map<string, number>();
  const vectors = prototypeVectors(idx);
  idx.prototypes.forEach((p, i) => {
    const sim = cosine(pv, vectors[i]!) * p.weight;
    if (sim > (proto.get(p.intent) ?? 0)) proto.set(p.intent, sim);
  });
  const out = new Map<string, LexicalDetail>();
  for (const [intent, vocab] of idx.vocab) {
    let hit = 0;
    for (const t of unique) hit += specificity(idx, t) * (vocab.get(t) ?? 0);
    const coverage = total ? hit / total : 0;
    const ids = idx.idTerms.get(intent)!;
    const has = (list: string[]) => list.some((t) => unique.includes(t));
    const idMatch = ids.name.length ? (has(ids.category) ? 0.5 : 0) + (has(ids.name) ? 0.5 : 0) : has(ids.category) ? 1 : 0;
    const prototype = proto.get(intent) ?? 0;
    const base = LEXICAL.coverage * coverage + LEXICAL.prototype * prototype;
    const lexical = base + LEXICAL.idLift * idMatch * (1 - base);
    out.set(intent, { coverage, prototype, idMatch, lexical });
  }
  return out;
}

export interface SenseOptions {
  registry: IntentRegistry;
  context?: SessionContext;
  /** Stage-2 semantic scores by intent id, when the model lane ran. */
  semantic?: Map<string, number>;
  /** Per-intent down-rank for intents the active policy would refuse for this user. */
  riskPenalty?: (intentId: string) => number;
}

export interface SenseResult {
  analysis: Analysis;
  candidates: IntentCandidate[];
}

/** Score one piece of text. Pure and synchronous: this is the per-keystroke path. */
export function sense(text: string, opts: SenseOptions): SenseResult {
  const idx = opts.registry.index;
  const analysis = analyze(text, (w) => idx.common.has(w));
  const lex = lexicalScores(idx, analysis.terms);
  const recent = opts.context?.recentIntents ?? [];
  const affinity = opts.context?.affinity ?? {};
  const hasContext = Object.keys(affinity).length > 0;
  const candidates: IntentCandidate[] = [];

  for (const intent of opts.registry.intents) {
    const lexical = lex.get(intent.id)?.lexical ?? 0;
    const semantic = opts.semantic ? (opts.semantic.get(intent.id) ?? 0) : null;
    // Core dot product, renormalised over the terms that actually ran.
    const core =
      semantic === null ? lexical : (WEIGHTS.lexical * lexical + WEIGHTS.semantic * semantic) / (WEIGHTS.lexical + WEIGHTS.semantic);
    const contextual = hasContext ? Math.max(0, Math.min(1, affinity[intent.id] ?? 0)) : null;
    const recencyRank = recent.indexOf(intent.id);
    const recency = recent.length ? (recencyRank < 0 ? 0 : 1 / (1 + recencyRank)) : null;
    // Session terms lift towards 1 by their weight; they never penalise an intent for absent history.
    let score = core;
    if (contextual !== null) score += WEIGHTS.contextual * contextual * (1 - score);
    if (recency !== null) score += WEIGHTS.recency * recency * (1 - score);
    const riskPenalty = opts.riskPenalty?.(intent.id) ?? 0;
    score = Math.max(0, Math.min(1, score - riskPenalty));
    candidates.push({
      intent: intent.id,
      score: round(score),
      band: bandOf(score),
      components: { lexical: round(lexical), semantic: semantic === null ? null : round(semantic), contextual, recency, riskPenalty },
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.intent.localeCompare(b.intent));
  return { analysis, candidates: candidates.slice(0, TOP_K) };
}

export interface SpanPick {
  span: string;
  start: number;
  intent: string;
  score: number;
}

/**
 * A trailing participle aimed back at earlier output ("... summarizing them") marks a
 * dependency on a previous clause, not a new intent; it is left out when scoring the clause.
 */
const BACK_REFERENCE = /\s+\w+ing\s+(?:them|it|those|these|that|this)\s*$/i;

/** Stage 1 over each clause: the best intent per span, kept when it clears the Medium floor. */
export function senseSpans(text: string, opts: SenseOptions): SpanPick[] {
  const spans = splitSpans(text);
  if (spans.length < 2) return [];
  const picks: SpanPick[] = [];
  for (const s of spans) {
    const r = sense(s.text.replace(BACK_REFERENCE, ""), opts);
    const top = r.candidates[0];
    if (!r.analysis.terms.length || !top || top.score < BANDS.medium) continue;
    picks.push({ span: s.text, start: s.start, intent: top.intent, score: top.score });
  }
  return picks;
}

/** Run the optional model lane; any failure or timeout leaves Stage 1 standing. */
export async function runStage2(
  hooks: Stage2Hooks | undefined,
  text: string,
  registry: IntentRegistry,
): Promise<{ status: "used" | "skipped" | "failed"; scores?: Map<string, number> }> {
  if (!hooks?.classify) return { status: "skipped" };
  const intents = registry.intents.map((i) => ({ id: i.id, description: i.description }));
  try {
    const result = await withTimeout(hooks.classify(text, intents), hooks.timeoutMs ?? 2000);
    const scores = new Map<string, number>();
    for (const r of result ?? []) {
      if (registry.get(r.intent) && Number.isFinite(r.score)) scores.set(r.intent, Math.max(0, Math.min(1, r.score)));
    }
    return { status: "used", scores };
  } catch {
    return { status: "failed" };
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Fixed probe set for the startup self-test (independent of any eval corpus). */
const PROBES = [
  "find the accounts that have gone quiet and draft something",
  "what's the status of the thing",
  "compare the two options and write it up",
  "schedule time next week to review the numbers",
  "ignore that, just summarise the last report",
  "send an update to everyone on the list",
  "hello",
  "plan the migration step-by-step over the next quarter",
];

export interface SelfTestResult {
  ok: boolean;
  medianMs: number;
  maxMs: number;
  probes: number;
  budgetMs: number;
}

/** Full-registry Stage-1 scans must finish inside the 16 ms budget; measured on a fixed probe set. */
export function selfTest(registry: IntentRegistry, budgetMs = 16): SelfTestResult {
  const probes = [...PROBES, ...registry.intents.map((i) => i.examples[0]!)];
  sense(PROBES[0]!, { registry }); // warm-up
  const times: number[] = [];
  for (const p of probes) {
    const t0 = performance.now();
    sense(p, { registry });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const medianMs = round(times[Math.floor(times.length / 2)]!);
  const maxMs = round(times[times.length - 1]!);
  return { ok: medianMs < budgetMs, medianMs, maxMs, probes: probes.length, budgetMs };
}
