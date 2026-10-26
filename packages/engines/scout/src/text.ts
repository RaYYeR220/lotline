/**
 * Text analysis for the Stage-1 lexical scan.
 *
 * analyze() turns a prompt (or a registry description/example) into an ordered list of
 * content terms: lowercased, stopwords removed, lightly stemmed, and folded through a
 * small general-English lexicon so that "stalled", "hasn't moved" and "at-risk" all land
 * on the same concept. Proper nouns are pulled out as entities: they are parameters and
 * references (Interpret), not intent evidence, so they never count towards a score.
 *
 * Registry text and prompts go through exactly the same function, which is what keeps the
 * scan symmetric: nothing here knows about any particular registry or corpus.
 */

const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by " +
    "can could did do does doing done down during each either else every few for from further had has have having he her here hers " +
    "herself him himself his how i if in into is it its itself just let lets me more most much my myself no nor not now of off on once " +
    "only or other our ours ourselves out over own please same she should so some such than that the their theirs them themselves then " +
    "there these they this those through to too under until up upon very was we were what when where which while who whom whose why will " +
    "with would you your yours yourself yourselves ok okay thanks thank kindly want wants need needs like maybe really still yet " +
    "whats hasnt havent hadnt dont doesnt didnt isnt arent wasnt werent wont cant couldnt shouldnt wouldnt im ive id youre theyre thats " +
    "theres heres whos lets ill youll next last per via etc going"
  ).split(/\s+/),
);

/** Quantities are parameters, never intent evidence. */
const NUMBER_WORDS = new Set(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty hundred thousand million dozen couple several".split(" "),
);

/** Multi-word phrases folded to a concept before tokenizing (applied to lowercased text, in order). */
const PHRASES: [RegExp, string][] = [
  [/\b(?:has|have|had|is|are|was|were)\s*(?:n['’]?t|not)\s+(?:moved|progressed|budged|advanced|closed|changed)\b/g, " stuck "],
  [/\b(?:not|no longer)\s+(?:moving|progressing|advancing)\b/g, " stuck "],
  [/\bno\s+(?:movement|progress|activity|response|reply)\b/g, " stuck "],
  [/\b(?:gone|went|going)\s+(?:quiet|dark|cold|silent)\b/g, " stuck "],
  [/\bat[\s-]risk\b/g, " stuck "],
  [/\bdeal\s+with\b/g, " handle "],
  [/\bcheck[\s-]?ins?\b/g, " meeting "],
  [/\bcatch[\s-]?ups?\b/g, " meeting "],
  [/\bone[\s-]on[\s-]ones?\b/g, " meeting "],
  [/\bfollow[\s-]?ups?\b/g, " followup "],
  [/\bstep[\s-]by[\s-]step\b/g, " stepwise "],
  [/\bon\s+(?:the|my|our|your)\s+calendar\b/g, " schedule "],
  [/\bset\s+up\s+(?:a\s+|an\s+)?(meeting|sync|call|time|slot)\b/g, " schedule $1 "],
  [/\bq[1-4]\b/g, " quarter "],
  [/\bfy\s?\d{2,4}\b/g, " year "],
  [/\bpros\s+and\s+cons\b/g, " compare "],
  [/\b(?:vs\.?|versus)(?=\s)/g, " compare "],
  [/\b(?:look|dig)\s+into\b/g, " research "],
  [/\bput\s+together\b/g, " draft "],
  [/\bwhat\s+(?:can|do)\s+you\s+do\b/g, " help "],
  [/\btl;?dr\b/g, " summarize "],
  [/\b(?:right\s+now|asap|as\s+soon\s+as\s+possible)\b/g, " "],
  // "moving X to the new platform" is a migration, not a record update.
  [/\bmov(?:e|es|ed|ing)\b(?=\s+(?:\w+\s+){0,3}(?:to|onto)\s+(?:the\s+|a\s+)?(?:new|another|different)\b)/g, " migrate "],
];

/** Single-word synonyms -> concept. Keys are stemmed when the table is built. */
const SYNONYM_GROUPS: Record<string, string[]> = {
  deal: ["deal", "opportunity", "opp"],
  stuck: ["stuck", "stall", "stalled", "stale", "stagnant", "slipping", "idle", "dormant"],
  recover: ["recover", "recovery", "rescue", "revive", "unstick", "salvage"],
  draft: ["draft", "write", "compose", "prepare"],
  email: ["email", "e-mail", "mail"],
  send: ["send", "blast", "broadcast", "dispatch", "mailout"],
  summarize: ["summarize", "summarise", "summary", "recap", "digest", "rundown"],
  compare: ["compare", "comparison", "contrast"],
  research: ["research", "investigate", "investigation", "explore", "study", "analyze", "analyse", "analysis"],
  competitor: ["competitor", "competition", "rival", "competitive"],
  market: ["market", "landscape", "industry", "space", "sector"],
  plan: ["plan", "roadmap", "planning"],
  migrate: ["migrate", "migration", "transition"],
  schedule: ["schedule", "book", "calendar", "reschedule"],
  meeting: ["meeting", "sync", "standup", "huddle", "appointment"],
  update: ["update", "change", "modify", "edit", "move"],
  show: ["show", "display", "view", "list"],
  find: ["find", "locate", "search", "identify"],
  get: ["get", "fetch", "retrieve", "pull", "grab"],
  metric: ["number", "metric", "figure", "kpi", "stat", "stats"],
  date: ["today", "tomorrow", "yesterday", "tonight", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "weekend"],
  customer: ["customer", "client"],
  hello: ["hello", "hi", "hey", "greetings", "howdy"],
  weather: ["weather", "forecast", "temperature", "rain", "sunny"],
  announce: ["announcement", "announce"],
  review: ["review", "retro", "retrospective"],
  quarantine: ["quarantine", "isolate", "segregate"],
  remove: ["remove", "withdraw"],
  notify: ["notify", "notification", "alert", "inform"],
};

/** Words that are never proper nouns even when capitalised mid-sentence (dates, lexicon words). */
const KNOWN_WORDS = new Set<string>();

const SYNONYMS = new Map<string, string>();
for (const [concept, words] of Object.entries(SYNONYM_GROUPS)) {
  for (const w of words) {
    SYNONYMS.set(stem(w.replace(/-/g, "")), concept);
    KNOWN_WORDS.add(w);
  }
}

/** Collapse a doubled final consonant left behind by suffix stripping ("planning" -> "plan"). */
function undouble(s: string): string {
  return /([bdfgmnprt])\1$/.test(s) ? s.slice(0, -1) : s;
}

/**
 * A deliberately light stemmer: plural and -ing/-ed suffixes plus a trailing "e". It only
 * has to be consistent (both sides of every comparison use it), not linguistically exact.
 */
export function stem(word: string): string {
  let s = word;
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !/(?:ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith("ing")) s = undouble(s.slice(0, -3));
  else if (s.length > 4 && s.endsWith("ed") && !s.endsWith("eed")) s = undouble(s.slice(0, -2));
  if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

/** NFKC, invisible/bidi control characters to spaces, whitespace collapsed. */
export function cleanText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁩﻿]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export interface EntityMention {
  text: string;
  start: number;
  end: number;
}

export interface Analysis {
  /** Ordered content terms (concepts), entities excluded. */
  terms: string[];
  /** Proper nouns in original casing, adjacent words merged ("Acme Corp"). */
  entities: EntityMention[];
}

const WORD = /[A-Za-z][A-Za-z0-9'’&-]*[A-Za-z0-9]|[A-Za-z]/g;

function isSentenceStart(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t" || ch === '"' || ch === "'" || ch === "(" || ch === "[" || ch === "*" || ch === "#") continue;
    return ch === "." || ch === "!" || ch === "?" || ch === ":" || ch === "\n" || ch === ">" || ch === "-";
  }
  return true;
}

/**
 * Find proper nouns: capitalised words that do not start a sentence, plus camel-case and
 * acronyms anywhere. A capitalised word the caller recognises as ordinary vocabulary
 * (isCommon) is not an entity, so "Send the Launch Announcement" keeps its content words.
 */
export function findEntities(text: string, isCommon: (lower: string) => boolean): EntityMention[] {
  const out: EntityMention[] = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0].replace(/['’]s$/, "");
    const lower = word.toLowerCase();
    if (word.length < 2 || STOPWORDS.has(lower) || /^q[1-4]$/i.test(word)) continue;
    const camel = /[a-z][A-Z]/.test(word);
    const acronym = /^[A-Z]{2,}$/.test(word);
    const capitalised = /^[A-Z]/.test(word);
    if (!camel && !acronym && !(capitalised && !isSentenceStart(text, m.index!))) continue;
    if (KNOWN_WORDS.has(lower) || isCommon(lower) || NUMBER_WORDS.has(lower)) continue;
    const start = m.index!;
    const end = start + word.length;
    const prev = out[out.length - 1];
    if (prev && /^\s+$/.test(text.slice(prev.end, start))) {
      prev.text = text.slice(prev.start, end);
      prev.end = end;
    } else {
      out.push({ text: word, start, end });
    }
  }
  return out;
}

/** Lowercase + phrase folding; exported for the parameter binder. */
export function foldPhrases(text: string): string {
  let s = ` ${text.toLowerCase()} `;
  for (const [re, rep] of PHRASES) s = s.replace(re, rep);
  return s;
}

/** Map one lowercased raw token to its concept, or null when it carries no intent evidence. */
export function toTerm(raw: string): string | null {
  let w = raw.replace(/['’]s$/, "").replace(/['’]/g, "");
  // Leading quantities are parameters: "6-month" -> "month", "5" -> dropped.
  w = w.replace(/^\d+(?:[.,]\d+)?-?/, "");
  if (w.length < 2 || /^\d/.test(w) || STOPWORDS.has(w) || NUMBER_WORDS.has(w)) return null;
  const joined = w.replace(/-/g, "");
  const s = stem(joined);
  return SYNONYMS.get(s) ?? s;
}

export function analyze(text: string, isCommon: (lower: string) => boolean = () => false): Analysis {
  const clean = cleanText(text);
  const entities = findEntities(clean, isCommon);
  const entityWords = new Set(entities.flatMap((e) => e.text.toLowerCase().split(/\s+/)));
  const folded = foldPhrases(clean);
  const terms: string[] = [];
  for (const m of folded.matchAll(/[a-z0-9$][a-z0-9'’.-]*[a-z0-9]|[a-z]/g)) {
    const raw = m[0].replace(/\.+$/, "");
    if (entityWords.has(raw.replace(/['’]s$/, ""))) continue;
    if (raw.startsWith("$")) continue;
    const t = toTerm(raw);
    if (t) terms.push(t);
  }
  return { terms, entities };
}

/** Lowercase words that occur in ordinary (non-proper-noun) use in the given texts. */
export function commonWords(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(WORD)) {
      const w = m[0].replace(/['’]s$/, "");
      if (w === w.toLowerCase()) out.add(w);
    }
  }
  return out;
}

export interface Span {
  text: string;
  start: number;
  end: number;
}

/**
 * Split a prompt into clauses for multi-intent detection: sentence ends, semicolons,
 * commas, and coordinating "and / then / also / plus".
 */
export function splitSpans(text: string): Span[] {
  const spans: Span[] = [];
  const sep = /(?<=[.!?])\s+|\s*;\s*|\s*,\s*(?:and\s+|then\s+|also\s+)?|\s+(?:and\s+then|and\s+also|and|then|also|plus)\s+/gi;
  let last = 0;
  for (const m of text.matchAll(sep)) {
    const piece = text.slice(last, m.index);
    if (piece.trim()) spans.push({ text: piece.trim(), start: last, end: m.index! });
    last = m.index! + m[0].length;
  }
  const tail = text.slice(last);
  if (tail.trim()) spans.push({ text: tail.trim().replace(/[.!?]+$/, ""), start: last, end: text.length });
  return spans.map((s) => ({ ...s, text: s.text.replace(/[.!?]+$/, "") }));
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
