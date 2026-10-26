// Carryover: the structured state block that crosses chunk boundaries, and
// the compression cascade that produces it. The cascade runs in strict order
// and records which rung produced the state:
//   1. marker override   text after [STATE_CHECKPOINT], if >= 24 chars
//   2. compressor        injected model call over previous state + chunk tail
//   3. heuristic         sentences led by "Therefore", "Key insight", "Status", "Next", ...
//   4. tail fallback     last words of the chunk, cut to the budget
// When a structured block is over budget it is trimmed by priority:
// progress (COMPLETED, REMAINING) first, then CONTEXT, decisions last.

import { cleanMarkers } from "./markers.ts";
import type { CascadeLevel, ChunkConfig, CompressorFn } from "./types.ts";

export const STATE_LABELS = ["COMPLETED", "REMAINING", "DECISIONS", "CONTEXT"] as const;
export type StateLabel = (typeof STATE_LABELS)[number];
export type StateBlock = Record<StateLabel, string[]>;

/** Trim order when over budget: lowest-value sections first. */
const DROP_ORDER: readonly StateLabel[] = ["COMPLETED", "REMAINING", "CONTEXT", "DECISIONS"];
const MIN_MARKER_STATE = 24;
const LABEL_LINE = /^\s*(COMPLETED|REMAINING|DECISIONS|CONTEXT)\s*:\s*(.*)$/i;
const KEY_PHRASE = /\b(therefore|key insight|status|next|decided|decision|conclusion)\b/i;

export const COMPRESSOR_SYSTEM_PROMPT =
  "You compress the state of a long-running task. Keep decisions (with their values), open questions, " +
  "entities and constraints; drop explanation and prose. Return 3-5 critical points as exactly four lines: " +
  "COMPLETED: ... / REMAINING: ... / DECISIONS: ... / CONTEXT: ...";

/** Parse a labeled state block. Returns undefined when no label is present. */
export function parseStateBlock(text: string): StateBlock | undefined {
  const block: StateBlock = { COMPLETED: [], REMAINING: [], DECISIONS: [], CONTEXT: [] };
  let current: StateLabel | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = LABEL_LINE.exec(line);
    if (m) {
      current = m[1].toUpperCase() as StateLabel;
      block[current].push(...splitItems(m[2]));
    } else if (current && line.trim()) {
      block[current].push(...splitItems(line.replace(/^\s*[-*]\s*/, "")));
    }
  }
  return current ? block : undefined;
}

export function formatStateBlock(block: StateBlock): string {
  return STATE_LABELS.filter((l) => block[l].length > 0)
    .map((l) => `${l}: ${block[l].join("; ")}`)
    .join("\n");
}

/** Fit state text to `budgetTokens` (×4 chars). Structured blocks lose progress before decisions. */
export function fitStateBlock(text: string, budgetTokens: number): { text: string; overflow: boolean } {
  const budget = budgetTokens * 4;
  if (text.length <= budget) return { text, overflow: false };
  const block = parseStateBlock(text);
  if (!block) return { text: headWords(text, budget), overflow: true };
  let out = formatStateBlock(block);
  while (out.length > budget) {
    const section = DROP_ORDER.find((l) => block[l].length > 0);
    if (!section) break;
    block[section].pop();
    out = formatStateBlock(block);
  }
  return { text: out.length > budget ? out.slice(0, budget) : out, overflow: true };
}

export interface NextCarryover {
  carryover: string;
  level: CascadeLevel;
  warnings: string[];
}

export class CarryoverService {
  constructor(private readonly compressorFn?: CompressorFn) {}

  async next(args: { markerState?: string; previousCarryover: string; chunkText: string; config: ChunkConfig }): Promise<NextCarryover> {
    const { config } = args;
    const budget = config.carryoverTokens * 4;
    const warnings: string[] = [];
    const fit = (text: string) => {
      const f = fitStateBlock(text, config.carryoverTokens);
      if (f.overflow) warnings.push(`carryover-overflow: state trimmed from ${text.length} to ${f.text.length} chars (budget ${budget})`);
      return f.text;
    };

    // 1. Marker override.
    const marker = sanitize(args.markerState ?? "");
    if (marker.length >= MIN_MARKER_STATE) {
      if (marker.length <= budget) return { carryover: marker, level: 1, warnings };
      if (parseStateBlock(marker)) return { carryover: fit(marker), level: 1, warnings };
      warnings.push("marker state is unstructured and over budget; compressing instead");
    } else if (marker) {
      warnings.push(`marker state shorter than ${MIN_MARKER_STATE} chars; compressing instead`);
    }

    // 2. Model compression.
    if (this.compressorFn) {
      try {
        const prompt =
          `Previous state:\n${args.previousCarryover || "(none)"}\n\n` +
          `Latest output (last 2000 chars):\n${args.chunkText.slice(-2000)}\n\n` +
          "Return the new state block.";
        const out = sanitize(await this.compressorFn(prompt, COMPRESSOR_SYSTEM_PROMPT));
        if (out.length >= MIN_MARKER_STATE) return { carryover: fit(out), level: 2, warnings };
        warnings.push("compressor returned too little; using heuristic extraction");
      } catch (err) {
        warnings.push(`compressor failed (${(err as Error).message}); using heuristic extraction`);
      }
    }

    // 3. Heuristic key-phrase extraction.
    const cleaned = cleanMarkers(args.chunkText);
    const hits = cleaned
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim().replace(/[.;]+$/, ""))
      .filter((s) => KEY_PHRASE.test(s))
      .slice(0, 5);
    const heuristic = hits.join("; ");
    if (heuristic.length >= MIN_MARKER_STATE) {
      return { carryover: heuristic.length <= budget ? heuristic : headWords(heuristic, budget), level: 3, warnings };
    }

    // 4. Absolute fallback: the tail of the chunk, or the previous state if the chunk was empty.
    const tail = tailWords(cleaned, budget);
    return { carryover: tail || tailWords(args.previousCarryover, budget), level: 4, warnings };
  }
}

function splitItems(s: string): string[] {
  return s
    .split(/;\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function sanitize(s: string): string {
  return cleanMarkers(s.replace(/\[(?:STATE_CHECKPOINT|STATE)\]|@@@STATE@@@|---STATE---|<\/?carryover>/gi, "")).trim();
}

function headWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return space > max * 0.6 ? cut.slice(0, space) : cut;
}

function tailWords(text: string, max: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  let len = 0;
  for (let i = words.length - 1; i >= 0; i--) {
    const add = words[i].length + (kept.length ? 1 : 0);
    if (len + add > max) break;
    kept.unshift(words[i]);
    len += add;
  }
  return kept.join(" ");
}
