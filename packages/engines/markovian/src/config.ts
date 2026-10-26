// Chunk config bounds and load-time validation, plus the token-efficiency
// math: the documented N-step model and the per-run computation that always
// uses the run's own config snapshot.

import type { ChunkConfig } from "./types.ts";

export const DEFAULT_CHUNK_CONFIG: Readonly<ChunkConfig> = Object.freeze({
  chunkSize: 8000,
  maxChunks: 24,
  carryoverTokens: 800,
  overlapTokens: 0,
});

export const CONFIG_BOUNDS: Readonly<Record<keyof ChunkConfig, { min: number; max: number }>> = Object.freeze({
  chunkSize: { min: 1000, max: 128_000 },
  maxChunks: { min: 1, max: 32 },
  carryoverTokens: { min: 128, max: 32_768 },
  overlapTokens: { min: 0, max: 4096 },
});

/** Engine constants: template overhead and expected per-step output. */
export const FRAMING_TOKENS = 400;
export const OUTPUT_BUDGET = 1200;

/** The fallback estimator. Numbers derived from it are labeled "estimated". */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export class MarkovianConfigError extends Error {
  constructor(
    readonly field: keyof ChunkConfig | "budget" | "contextWindow",
    message: string,
  ) {
    super(`Markovian config: ${message}`);
    this.name = "MarkovianConfigError";
  }
}

/**
 * Merge a partial config over the defaults and validate it. Out-of-range or
 * under-budgeted values throw; nothing is clamped silently. `tokensPerChunk`
 * is accepted as an alias of `chunkSize`.
 */
export function resolveChunkConfig(
  partial: Partial<ChunkConfig> & { tokensPerChunk?: number } = {},
  opts: { contextWindow?: number } = {},
): ChunkConfig {
  const { tokensPerChunk, ...rest } = partial;
  const merged: ChunkConfig = { ...DEFAULT_CHUNK_CONFIG, ...(tokensPerChunk !== undefined ? { chunkSize: tokensPerChunk } : {}), ...rest };
  for (const key of Object.keys(CONFIG_BOUNDS) as (keyof ChunkConfig)[]) {
    const v = merged[key];
    const { min, max } = CONFIG_BOUNDS[key];
    if (!Number.isInteger(v)) throw new MarkovianConfigError(key, `${key} must be an integer, got ${v}`);
    if (v < min || v > max) throw new MarkovianConfigError(key, `${key}=${v} is outside [${min}, ${max}]`);
  }
  const needed = FRAMING_TOKENS + merged.carryoverTokens + OUTPUT_BUDGET;
  if (merged.chunkSize < needed) {
    throw new MarkovianConfigError(
      "budget",
      `chunkSize=${merged.chunkSize} cannot hold framing (${FRAMING_TOKENS}) + carryover (${merged.carryoverTokens}) + output (${OUTPUT_BUDGET}) = ${needed}`,
    );
  }
  if (opts.contextWindow !== undefined && merged.chunkSize + merged.overlapTokens > opts.contextWindow) {
    throw new MarkovianConfigError(
      "contextWindow",
      `chunkSize + overlapTokens (${merged.chunkSize + merged.overlapTokens}) exceeds the model context window (${opts.contextWindow})`,
    );
  }
  return merged;
}

/** Constants of the documented efficiency model. */
export const MODEL_CONSTANTS = { framing: 400, goal: 200, stepInput: 300, output: 1200, carryover: 800 } as const;

/**
 * The N-step efficiency model:
 *   naive     = N(F + G + S) + O·N(N−1)/2      (history grows every step)
 *   markovian = N(F + G + C + S)               (carryover is bounded)
 */
export function modelTotals(n: number, k: Partial<typeof MODEL_CONSTANTS> = {}) {
  const c = { ...MODEL_CONSTANTS, ...k };
  const naiveTotal = n * (c.framing + c.goal + c.stepInput) + (c.output * n * (n - 1)) / 2;
  const markovianTotal = n * (c.framing + c.goal + c.carryover + c.stepInput);
  const savings = naiveTotal - markovianTotal;
  return { n, naiveTotal, markovianTotal, savings, efficiency: naiveTotal > 0 ? savings / naiveTotal : 0 };
}

/**
 * Efficiency of a finished run, against the config it ran with:
 *   standard  = Σ_i (Σ_{j<i} tokens_j + tokens_i)   (prefix sums: full history each step)
 *   markovian = chunks × carryoverTokens + Σ tokens
 */
export function runEfficiency(chunks: readonly { tokens: number }[], config: Pick<ChunkConfig, "carryoverTokens">) {
  let prefix = 0;
  let standardCost = 0;
  for (const c of chunks) {
    standardCost += prefix + c.tokens;
    prefix += c.tokens;
  }
  const totalTokensUsed = prefix;
  const markovianCost = chunks.length * config.carryoverTokens + totalTokensUsed;
  const tokensSaved = Math.max(0, standardCost - markovianCost);
  return {
    totalTokensUsed,
    standardCost,
    markovianCost,
    tokensSaved,
    efficiencyPercent: standardCost > 0 ? (tokensSaved / standardCost) * 100 : 0,
  };
}

/** Projected per-step cost of naive vs Markovian prompting, for charts before any run exists. */
export function projectionCurve(config: ChunkConfig, steps = 10) {
  const out: { step: number; standard: number; markovian: number; standardCumulative: number; markovianCumulative: number }[] = [];
  let sc = 0;
  let mc = 0;
  for (let step = 1; step <= steps; step++) {
    const standard = (step - 1) * config.chunkSize + config.chunkSize;
    const markovian = config.carryoverTokens + config.chunkSize;
    sc += standard;
    mc += markovian;
    out.push({ step, standard, markovian, standardCumulative: sc, markovianCumulative: mc });
  }
  return out;
}
