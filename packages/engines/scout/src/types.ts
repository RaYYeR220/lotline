/**
 * Shared shapes for the Scout pipeline: Sense -> Interpret -> Guard -> Route -> Recommend.
 * Field names follow the Meterless Scout Intent spec so the upstream eval harness and any
 * spec-conforming downstream engine can read our decisions and contracts unchanged.
 */

export type RiskClass = "low" | "medium" | "high";
export type RiskLevel = RiskClass | "block";
/** Confidence bands: high >= 0.80, medium 0.55-0.79, low 0.40-0.54, reject < 0.40. */
export type Band = "high" | "medium" | "low" | "reject";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ParamSpec {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: ParamSpec;
  optional?: boolean;
  description?: string;
}

export interface ParameterSchema {
  type?: string;
  properties?: Record<string, ParamSpec>;
  required?: string[];
}

export interface Intent {
  id: string;
  category: string;
  description: string;
  parameters: ParameterSchema;
  capabilities: string[];
  riskClass: RiskClass;
  surfaces: string[];
  roles: string[];
  examples: string[];
  version: number;
}

export interface RegistryDocument {
  version?: number;
  note?: string;
  intents: Intent[];
}

export interface UserRef {
  id: string;
  role?: string;
  /** Tool permissions held by the user; tools that require others are dropped at routing. */
  permissions?: string[];
}

// ---------------------------------------------------------------------------
// Sense
// ---------------------------------------------------------------------------

export interface ScoreComponents {
  lexical: number;
  /** null when no Stage-2 model lane ran. */
  semantic: number | null;
  /** null when the caller supplied no session context. */
  contextual: number | null;
  recency: number | null;
  riskPenalty: number;
}

export interface IntentCandidate {
  intent: string;
  score: number;
  band: Band;
  span?: string;
  components: ScoreComponents;
}

/** Optional model lane. Scores are 0..1 per intent id; missing intents count as 0. */
export interface Stage2Hooks {
  classify?: (text: string, intents: { id: string; description: string }[]) => Promise<{ intent: string; score: number }[]>;
  injection?: (text: string) => Promise<{ score: number; kind?: string }>;
  /** Milliseconds before a hook is abandoned and Stage 1 stands (default 2000). */
  timeoutMs?: number;
}

export interface SessionContext {
  /** Intent ids used earlier in this session, most recent first. */
  recentIntents?: string[];
  /** Earlier turns; a non-empty list lets references like "the thing we discussed" resolve. */
  recentTurns?: string[];
  /** Active workflow / retrieved memory hints: intent id -> 0..1 affinity. */
  affinity?: Record<string, number>;
  /** Retrieved snippets (documents, partner notes). Data, never instructions. */
  snippets?: string[];
}

// ---------------------------------------------------------------------------
// Interpret
// ---------------------------------------------------------------------------

export interface EntityRef {
  text: string;
  kind: string;
  id: string;
}

export interface BoundIntent {
  id: string;
  version: number;
  confidence: number;
  band: Band;
  span?: string;
  parameters: Record<string, unknown>;
  references: Record<string, EntityRef>;
  /** Set when the Reject band fell back to GENERAL. */
  fallbackFrom?: string;
}

export type ClarificationTrigger = "low-band" | "tie" | "params" | "high-risk" | "underspecified" | "reference-unresolved";

export interface Clarification {
  trigger: ClarificationTrigger;
  reason: string;
  question: string;
  options: { label: string; intent: string }[];
}

export type ExecutionMode = "single_step" | "parallel" | "plan_then_execute";

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export type GuardLayer = "injection" | "policy" | "scope" | "pii" | "rate-limit";

export interface RiskFlag {
  kind: string;
  layer: GuardLayer;
  severity: "warn" | "block";
  /** Detection method for injection flags: pattern, role-drift, tool-ref or model. */
  method?: string;
  score?: number;
  /** Pattern ids and short markers. Injection payloads are never copied here. */
  evidence?: string[];
  detail?: string;
}

export interface Redaction {
  kind: string;
  start: number;
  end: number;
  replacement: string;
}

export interface ApprovalSpec {
  kind: "user-confirm" | "operator-review";
  reason: string;
}

export interface ApprovalRecord {
  kind: "user-confirm" | "operator-review";
  at: string;
  by?: string;
  decision: "approve" | "reject";
  confirmation?: string;
}

export interface GuardResult {
  level: RiskLevel;
  flags: RiskFlag[];
  redactions: Redaction[];
  redactedPrompt: string;
  approvalsRequired: ApprovalSpec[];
  reason?: string;
}

// ---------------------------------------------------------------------------
// Route + Recommend
// ---------------------------------------------------------------------------

export interface ToolRegistration {
  capability: string;
  toolId: string;
  availability?: () => boolean;
  requiredPermissions?: string[];
  cost?: { perCall: number };
  latency?: { p95Ms: number };
  /** Local tools win ties (local-first default). */
  local?: boolean;
  /** Surfaces this tool prefers (e.g. an email-first tool prefers "inbox"). */
  surfaces?: string[];
  invoke?: (input: unknown) => Promise<unknown>;
}

export interface ToolStep {
  step: number;
  capability: string;
  tool: string;
  fromIntent: string;
  /** Set for steps pulled in transitively (e.g. swarm.run -> memory.recall). */
  requiredBy?: string;
  input: Record<string, unknown>;
  local: boolean;
  modelProfile: string | null;
}

export interface UnresolvedCapability {
  capability: string;
  fromIntent: string;
  error: "no_adapter" | "permission" | "unavailable";
  severity: "warn" | "error";
}

export type DataClass = "public" | "internal" | "confidential" | "restricted";

export interface ModelProfile {
  id: string;
  provider: string;
  model: string;
  context: number;
  cost: { in: number; out: number };
  latency: { p95Ms: number };
  capabilities: string[];
  dataClasses: DataClass[];
  quality?: "basic" | "standard" | "high";
  fallbacks?: string[];
}

export interface ModelProfileRef {
  id: string;
  provider: string;
  model: string;
  fallbacks: string[];
}

// ---------------------------------------------------------------------------
// Contract + decision
// ---------------------------------------------------------------------------

export interface ScoutContract {
  contractId: string;
  parentId?: string;
  traceId: string;
  intent: {
    primary: { id: string; version: number };
    parameters: Record<string, unknown>;
    references: Record<string, EntityRef>;
    confidence: number;
    alternates: { intent: string; score: number }[];
    secondary: { id: string; span?: string; confidence: number; parameters: Record<string, unknown> }[];
    executionMode: ExecutionMode;
  };
  risk: {
    level: RiskClass;
    flags: RiskFlag[];
    redactions: Redaction[];
    approvalsRequired: ApprovalSpec[];
    approvals: ApprovalRecord[];
  };
  toolPlan: ToolStep[];
  modelProfile: ModelProfileRef;
  scope: {
    user: UserRef;
    surface: string;
    capabilities: string[];
    deadline?: string;
    budget?: { tokensMax?: number; costMaxUSD?: number };
  };
  issuedAt: string;
  expiresAt: string;
  registryVersion: number;
  registryDigest: string;
  policyPackVersion: string;
  signature: string;
  signedBy: "scout";
}

export interface DecideInput {
  prompt: string;
  user?: UserRef;
  surface?: string;
  context?: SessionContext;
  dataClass?: DataClass;
  budget?: { tokensMax?: number; costMaxUSD?: number };
  /** Skip Sense: a structured caller (or a resolved clarification) names the intent. */
  intent?: string;
  parameters?: Record<string, unknown>;
  traceId?: string;
}

export interface Decision {
  traceId: string;
  intent: BoundIntent | null;
  secondary: BoundIntent[];
  executionMode: ExecutionMode;
  candidates: IntentCandidate[];
  clarification: Clarification | null;
  risk: GuardResult;
  toolPlan: ToolStep[];
  unresolved: UnresolvedCapability[];
  modelProfile: ModelProfileRef | null;
  executionContract: ScoutContract | null;
  error?: { code: string; message: string };
  stage2: "used" | "skipped" | "failed";
  latencyMs: number;
}

export type ScoutEvent =
  | { type: "scout.decision"; traceId: string; intent: string | null; band: Band | null; latencyMs: number; stage2: string }
  | { type: "scout.clarification"; traceId: string; trigger: ClarificationTrigger }
  | { type: "scout.block"; traceId: string; reason: string; kinds: string[] }
  | { type: "contract.issued"; traceId: string; contractId: string; intent: string; risk: RiskClass; profile: string }
  | { type: "contract.refused"; traceId: string; reason: string };
