// Canonical Markovian shapes: chunk config, per-step records, run records,
// cumulative stats and the provider-agnostic generator contract.

export interface ChunkConfig {
  /** Total per-chunk token budget for one model call. */
  chunkSize: number;
  /** Hard stop after this many chunks. */
  maxChunks: number;
  /** Budget for the state carried into the next chunk. */
  carryoverTokens: number;
  /** Tail of the previous chunk's output repeated in an [OVERLAP] block (0 = off). */
  overlapTokens: number;
}

export type Mode = "ARCHITECT" | "RESEARCH";
export type TokenLabel = "estimated" | "measured";
export type RunStatus = "running" | "completed" | "max-chunks" | "errored" | "aborted" | "paused";

/** Which rung of the compression cascade produced a carryover. */
export type CascadeLevel = 1 | 2 | 3 | 4;

export interface MarkerSet {
  /** Text after the state marker (or inside <CARRYOVER>), before any compression. */
  state?: string;
  final: boolean;
  format: "bracket" | "xml" | "legacy" | "none";
  needsTool?: { tool: string; input: string };
  needsClarification?: string;
  progress?: string;
}

export interface ChunkRecord {
  /** 1-based step index (ChunkInfo.id). */
  id: number;
  step: number;
  /** Output tokens of the display content (ChunkInfo.tokens). */
  tokens: number;
  /** State passed into this step (ChunkInfo.carryover). */
  carryover: string;
  /** Display-safe output, markers removed (ChunkInfo.content). */
  content: string;
  prompt: string;
  /** Raw generator output. */
  output: string;
  markers: MarkerSet;
  carryoverIn: string;
  carryoverOut: string;
  cascadeLevel: CascadeLevel;
  promptTokensIn: number;
  outputTokensOut: number;
  tokenLabel: TokenLabel;
  latencyMs: number;
  warnings: string[];
  toolCalls?: { tool: string; input: string; result: string }[];
}

export type ReflectionMode = "conclude" | "ratify" | "refine";

export interface ReflectionResult {
  mode: ReflectionMode;
  verdict: "concluded" | "ratified" | "flagged" | "refined" | "skipped";
  text?: string;
  issues?: string[];
  /** Kept whenever a refinement replaced the run output. */
  originalOutput?: string;
  error?: string;
}

export interface PendingInput {
  kind: "tool" | "clarification";
  tool?: string;
  input?: string;
  question?: string;
}

export interface MarkovianRun {
  id: string;
  goal: string;
  /** Goal truncated for storage. */
  prompt: string;
  mode: Mode;
  /** Mandatory per-run config snapshot; historical efficiency always uses it. */
  chunkConfig: ChunkConfig;
  chunks: ChunkRecord[];
  totalTokensUsed: number;
  totalTokensSaved: number;
  efficiencyPercent: number;
  durationMs: number;
  timestamp: number;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  tokenLabel: TokenLabel;
  /** Joined display content of every chunk (or the refined output). */
  output: string;
  reflection?: ReflectionResult;
  error?: string;
  errors: string[];
  warnings: string[];
  pending?: PendingInput;
  /** Carryover handed in before chunk 1 (chained runs). */
  initialCarryover?: string;
  resumes: { at: number; fromStep: number; previousStatus: RunStatus }[];
  /** Free-form host metadata persisted with the run (e.g. a drill's lot list). */
  meta?: Record<string, unknown>;
}

export interface CumulativeStats {
  totalRuns: number;
  completedRuns: number;
  totalTokensUsed: number;
  totalTokensSaved: number;
  averageEfficiency: number;
  totalChunksProcessed: number;
  lastRunTimestamp: number;
  efficiencyHistory: { timestamp: number; efficiency: number; tokensSaved: number }[];
}

export interface GeneratorResult {
  text: string;
  /** Provider-reported usage; when present the numbers are labeled "measured". */
  usage?: { input_tokens?: number; output_tokens?: number };
  metadata?: unknown;
}

/** Extra context the engine hands every generator call. */
export interface GeneratorExtras {
  runId: string;
  step: number;
  carryover: string;
  meta?: Record<string, unknown>;
}

export interface Attachment {
  name: string;
  content: string;
}

export type Generator = (
  prompt: string,
  attachments: Attachment[],
  systemPrompt?: string,
  onStream?: (delta: string) => void,
  abortSignal?: AbortSignal,
  extras?: GeneratorExtras,
) => Promise<GeneratorResult>;

/** Simpler step shape: receives the goal and carried state, returns text. */
export type StepFn = (args: { goal: string; carryover: string; step: number; prompt: string }) =>
  | Promise<{ content: string } | string>
  | { content: string }
  | string;

export type CompressorFn = (prompt: string, systemPrompt: string) => Promise<string>;

export interface RunOptions {
  goal?: string;
  /** Alias of goal. */
  prompt?: string;
  mode?: Mode;
  generator?: Generator;
  stepFn?: StepFn;
  systemPrompt?: string;
  /** Injected into chunk 1 only, ahead of the request. */
  memoryContext?: string;
  /** Chunk 1 only. */
  attachments?: Attachment[];
  abortSignal?: AbortSignal;
  onStream?: (delta: string) => void;
  /** Reflection pass on completed runs (default: conclude). false skips it. */
  reflect?: boolean | { mode: ReflectionMode };
  /** State to start from, for runs chained after another run. */
  carryover?: string;
  /** Fulfil [NEEDS_TOOL] markers inline; without it the run pauses. */
  onTool?: (tool: string, input: string) => Promise<string>;
  stopWhen?: (args: { step: number; carryover: string }) => boolean;
  meta?: Record<string, unknown>;
}

export interface ResumeOptions extends Omit<RunOptions, "goal" | "prompt" | "mode" | "carryover" | "meta"> {
  /** Answer for a paused run (tool result or clarification). */
  stepInput?: string;
}
