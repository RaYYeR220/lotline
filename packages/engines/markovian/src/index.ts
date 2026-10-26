// @lotline/markovian: bounded-context chunk runner (marker protocol,
// compression cascade, per-step history, crash resume, efficiency math) and
// the Lotline traceability drill built on it.

export * from "./types.ts";
export { Markovian } from "./markovian.ts";
export type { MarkovianOptions } from "./markovian.ts";
export {
  CONFIG_BOUNDS,
  DEFAULT_CHUNK_CONFIG,
  FRAMING_TOKENS,
  MODEL_CONSTANTS,
  MarkovianConfigError,
  OUTPUT_BUDGET,
  estimateTokens,
  modelTotals,
  projectionCurve,
  resolveChunkConfig,
  runEfficiency,
} from "./config.ts";
export { cleanMarkers, parseMarkers } from "./markers.ts";
export {
  COMPRESSOR_SYSTEM_PROMPT,
  CarryoverService,
  STATE_LABELS,
  fitStateBlock,
  formatStateBlock,
  parseStateBlock,
} from "./carryover.ts";
export type { NextCarryover, StateBlock, StateLabel } from "./carryover.ts";
export { buildPrompt, overlapSlice } from "./prompt.ts";
export { RunHistory } from "./history.ts";
export { ProgressService } from "./progress.ts";
export type { Phase, ProgressState } from "./progress.ts";
export { resumeDrill, runDrill } from "./drill.ts";
export type { DrillChunkTelemetry, DrillGap, DrillOptions, DrillReport, DrillState, DrillStep } from "./drill.ts";
