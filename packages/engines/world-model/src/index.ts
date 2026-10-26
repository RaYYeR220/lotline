// @lotline/world-model: an event-sourced World Model engine (Meterless World
// Model spec) and the Lotline trace graph built on it.

export { WorldModel } from "./world.ts";
export { GraphView, isValidAt, type EdgeQuery } from "./views.ts";
export { canonicalJson, entityIdFromName, externalEntityId, normalizeName, relationId, sha256Hex } from "./ids.ts";
export { MERGE_BANDS, decide, levenshtein, nameSimilarity, type MergeDecision } from "./resolve.ts";
export {
  LINK_CARDINALITY, LINK_KINDS, evidenceKey, explainPath, ingestLinks, linkToRelation, reachableFrom,
  type LinkRelation, type PathStep, type ReachOptions,
} from "./trace-graph.ts";
export type * from "./types.ts";
