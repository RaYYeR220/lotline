// Scout Intent engine. `Scout` is the class the Meterless eval harness loads via SCOUT_IMPL.
export { Scout, type ScoutOptions } from "./scout.ts";
export { IntentRegistry, GENERAL_INTENT } from "./registry.ts";
export { CapabilityGraph, ScoutError, DEFAULT_TOOLS, CAPABILITY_DEPENDENCIES, CAPABILITY_FAMILIES } from "./route.ts";
export { ModelRouter, DEFAULT_PROFILES, lotlineProfiles, type Routing } from "./profiles.ts";
export { BUILTIN_PACKS, composePacks, type PolicyPack, type InjectionPattern, type PackSpec } from "./packs.ts";
export { scanInjection, findPii } from "./risk.ts";
export { BANDS, WEIGHTS, bandOf } from "./sense.ts";
export { canonicalJson, verifyScoutContract, type VerifyResult } from "./contract.ts";
export { LOTLINE_INTENTS } from "./lotline-intents.ts";

// Lotline policy pack: recall execution contracts.
export {
  issueContract,
  verifyContract,
  scanUntrusted,
  RECALL_POLICY,
  type ExecutionContract,
  type ContractRequest,
  type ContractRefusal,
  type RecallIntent,
} from "./policy.ts";

export type * from "./types.ts";
