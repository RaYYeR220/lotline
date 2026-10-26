// @lotline/hmem: H-MEM partner memory (tiered memory, hybrid ranking, trust
// ledger, conflicts, preview-first sleep, reviewed dreaming) plus the Lotline
// helpers for partner quirks and link rulings.

export * from "./types.ts";
export { HMEM } from "./hmem.ts";
export type { HMEMOptions } from "./hmem.ts";
export { MemoryStore, snapshot } from "./store.ts";
export type { MutationOptions } from "./store.ts";
export { TrustLedger } from "./ledger.ts";
export { RetrievalService, WEIGHTS, WEIGHT_PROFILE, formatContext } from "./retrieval.ts";
export type { QueryOptions, QueryResult, RankedMemory, RankSignals } from "./retrieval.ts";
export { ConflictService, detect } from "./conflicts.ts";
export type { ResolveOptions } from "./conflicts.ts";
export { SleepService } from "./sleep.ts";
export { DreamingService } from "./dreaming.ts";
export { HashEmbedder, classifyDomain, cosine, extractEntities, jaccard, keywords, tokenize } from "./text.ts";
export {
  QUIRK_TAG,
  RULING_TAG,
  recallQuirks,
  recallRulings,
  rememberQuirk,
  rememberRuling,
} from "./partner.ts";
export type { PartnerWriteOptions, RecallOptions, RecalledQuirk, RecalledRuling, Ruling } from "./partner.ts";
