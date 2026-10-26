// Text utilities shared by every H-MEM service: tokenizer, a small local
// embedder, similarity measures, entity extraction and domain inference.
// Everything here is deterministic and offline, so rankings reproduce
// exactly across runs and machines.

import type { Embedder, Entity, MemoryType } from "./types.ts";
import { DEFAULTS } from "./types.ts";

const STOPWORDS = new Set(
  (
    "a an the of for to in on at by is are was were be been being it its this that these those and or but as " +
    "with from into onto we you they he she i me my our your their them us do does did done when what which who " +
    "whom how where why there here has have had will would can could should may might must about all any some so " +
    "if then than also just only very per via each every both such own same too out up down over under again"
  ).split(" "),
);

/** Minimal plural folding so "lots"/"lot" and "dashes"/"dash" match. */
export function stem(token: string): string {
  if (token.length <= 3 || /\d/.test(token)) return token;
  if (token.endsWith("ies") && token.length > 4) return token.slice(0, -3) + "y";
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (/(?:ss|us|is)$/.test(token)) return token;
  if (/(?:ches|shes|xes|zes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/** Lowercased word tokens, split on anything that is not a letter or digit. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 || /\d/.test(t));
}

/** Content-bearing tokens: stopwords removed, plurals folded, order kept. */
export function keywords(text: string): string[] {
  return tokenize(text)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

/** First `n` distinct keywords, used as the query side of the keyword signal. */
export function topKeywords(text: string, n = 8): string[] {
  return [...new Set(keywords(text))].slice(0, n);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Feature-hashing embedder: whole words plus character trigrams, hashed into a
 * fixed number of signed buckets and L2-normalised. Trigrams let near spellings
 * ("PKyyMMddseq" vs "PK-yyMMdd-seq", "code" vs "codes") land close together.
 */
export class HashEmbedder implements Embedder {
  constructor(readonly dim = 256) {}

  embed(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      vec[h % this.dim] += (h & 0x80000000 ? -1 : 1) * weight;
    };
    for (const word of keywords(text)) {
      add(`w:${word}`, 1);
      const padded = `^${word}$`;
      const grams = padded.length - 2;
      for (let i = 0; i < grams; i++) add(`g:${padded.slice(i, i + 3)}`, 0.5 / Math.sqrt(grams));
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm === 0 ? vec : vec.map((v) => v / norm);
  }
}

/** Cosine similarity of two unit vectors (a plain dot product). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

const TECH_TERMS = new Set([
  "api", "react", "python", "typescript", "javascript", "rust", "sqlite", "postgres", "postgresql", "duckdb",
  "minio", "docker", "kafka", "redis", "graphql", "node", "csv", "parquet", "json", "sql", "rest", "s3",
]);

/**
 * Heuristic entity extraction: dotted table names, snake_case fields, lot and
 * location codes, acronyms, known technologies and mid-sentence proper nouns.
 * Names are normalised to lowercase and capped per record.
 */
export function extractEntities(text: string): Entity[] {
  const found = new Map<string, Entity>();
  const put = (name: string, type: string) => {
    const key = name.toLowerCase();
    if (!found.has(key)) found.set(key, { name: key, type });
  };
  let rest = text;
  for (const m of text.matchAll(/\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/gi)) {
    put(m[0], "table");
    rest = rest.replace(m[0], " ");
  }
  for (const m of rest.matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gi)) put(m[0], "field");
  for (const m of rest.matchAll(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\b/g)) {
    const tok = m[0];
    if (/\d/.test(tok)) put(tok, "code");
    else if (tok.length >= 2) put(tok, "term");
  }
  for (const t of tokenize(rest)) if (TECH_TERMS.has(t)) put(t, "technology");
  for (const m of rest.matchAll(/(?<![.!?]\s|^)\b([A-Z][a-z]{2,})\b/g)) {
    if (!STOPWORDS.has(m[1].toLowerCase())) put(m[1], "name");
  }
  return [...found.values()].slice(0, DEFAULTS.entityCap);
}

// Declaration order breaks ties between equally scored domains.
const DOMAIN_KEYWORDS: [string, string[]][] = Object.entries({
  "partner-data": [
    "lot", "vendor", "receiving", "receipt", "shipment", "shipping", "wms", "lpn", "packer", "grower", "retail",
    "carrier", "bol", "column", "table", "format", "sku", "dash", "separator", "harvest", "cooling", "repack",
    "pallet", "supplier", "quirk",
  ],
  trace: [
    "link", "ruling", "ruled", "proven", "unproven", "rejected", "recall", "evidence", "edge", "custody",
    "implicated", "trace", "traced", "fda", "notice",
  ],
  tech: ["code", "bug", "database", "deploy", "server", "framework", "library", "release", ...TECH_TERMS],
  work: ["meeting", "deadline", "client", "project", "sprint", "review", "report", "office", "roadmap", "quarterly"],
  personal: ["family", "hobby", "prefer", "like", "dislike", "morning", "evening", "coffee", "parking", "weekend"],
}).map(([domain, kws]) => [domain, kws.map(stem)]);

/**
 * Multi-pass domain inference: explicit tags win, then weighted keyword
 * scoring with a nudge from the memory type, then "general".
 */
export function classifyDomain(content: string, tags: readonly string[] = [], type: MemoryType = "general"): string {
  for (const t of tags) {
    if (t.startsWith("domain:")) return t.slice("domain:".length);
    if (t.startsWith("project:")) return t.slice("project:".length);
    if (t.startsWith("tech:")) return "tech";
  }
  const words = new Set(keywords(content));
  let best = "general";
  let bestScore = 0;
  for (const [domain, kws] of DOMAIN_KEYWORDS) {
    let score = kws.reduce((s, kw) => s + (words.has(kw) ? 1 : 0), 0);
    if (domain === "personal" && (type === "personal" || type === "preference")) score += 1;
    if (score > bestScore) {
      best = domain;
      bestScore = score;
    }
  }
  return best;
}

export function namespaceFor(domain: string, type: MemoryType): string {
  const bucket = type === "preference" || type === "personal" ? "profile" : type === "factual" ? "facts" : "notes";
  return `${domain}/${bucket}`;
}

/** Normalised content used for duplicate detection. */
export function normalizeContent(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}
