// Canonical H-MEM shapes: the memory record, the trust ledger entry, conflict
// records, sleep previews/reports and dream proposals. Field names follow the
// Meterless H-MEM spec so records stay portable between implementations.

export type MemoryType = "personal" | "factual" | "preference" | "general";
export type MemoryLayer = "short_term" | "working" | "long_term";

export type MemoryOrigin =
  | "chat" | "import" | "web" | "decision" | "curiosity" | "goal_run"
  | "user_explicit" | "inference" | "plan_run" | "mission" | "swarm_run"
  | "tool" | "brain";

export interface MemoryProvenance {
  origin: MemoryOrigin;
  learnedAt: number;
  /** Human-readable "how I learned this". */
  label: string;
  refs?: {
    chatId?: string;
    importRunId?: string;
    importSource?: string;
    sourceUrl?: string;
    sourceDomain?: string;
    decisionId?: string;
    goalRunId?: string;
  };
}

export interface Entity {
  name: string;
  type: string;
}

/**
 * Optional structured claim. Two live records with the same subject and a
 * different value contradict each other regardless of wording.
 */
export interface Claim {
  subject: string;
  value: string;
}

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  timestamp: number;
  lastAccessed: number;
  accessCount: number;
  tags: string[];
  domain: string;
  namespace: string;
  /** Runtime only: recomputed on load, never written to the file store. */
  embedding?: number[];
  /** Runtime only: last retrieval score. */
  score?: number;
  confidence: number;
  source: string;
  provenance: MemoryProvenance;
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  entities: Entity[];
  relatedTo: string[];
  supersedes?: string;
  supersededBy?: string;
  derivedFrom: string[];
  claim?: Claim;
}

export interface AddInput {
  content: string;
  source: string;
  type?: MemoryType;
  layer?: MemoryLayer;
  tags?: string[];
  confidence?: number;
  provenance?: MemoryProvenance;
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  domain?: string;
  namespace?: string;
  supersedes?: string;
  derivedFrom?: string[];
  claim?: Claim;
  /** Who is writing; defaults to the engine actor. */
  actor?: string;
}

// The 17 canonical ledger actions, plus the rotation marker a constrained
// client writes before trimming (this implementation never trims).
export type LedgerAction =
  | "create" | "read" | "update" | "delete" | "feedback" | "promote" | "demote" | "merge"
  | "conflict_detected" | "conflict_resolved"
  | "sleep_consolidate" | "sleep_archive" | "sleep_synthesize"
  | "dream_proposed" | "dream_approved" | "dream_rejected" | "restore"
  | "ledger_rotated";

export type MemorySnapshot = Partial<Omit<Memory, "embedding" | "score">>;

export interface LedgerEntry {
  id: string;
  memoryId: string;
  action: LedgerAction;
  actor: string;
  timestamp: number;
  previousState?: MemorySnapshot;
  newState?: MemorySnapshot;
  details?: Record<string, unknown>;
}

export type FeedbackKind = "helpful" | "not_helpful" | "wrong";

export const FEEDBACK_DELTAS: Record<FeedbackKind, number> = {
  helpful: 0.05,
  not_helpful: -0.03,
  wrong: -0.2,
};

export type ConflictKind = "opposing-phrase" | "negation" | "numeric" | "same-subject";
export type ResolutionStrategy = "keep_a" | "keep_b" | "keep_both" | "merge" | "delete_both";

export interface ConflictRecord {
  id: string;
  memoryA: string;
  memoryB: string;
  kind: ConflictKind;
  reason: string;
  /** Detection confidence: how sure we are that A and B really contradict. */
  confidence: number;
  status: "open" | "resolved";
  detectedAt: number;
  resolution?: ResolutionStrategy;
  winner?: string;
  /** Auto-decision confidence, when the resolver computed one. */
  decisionConfidence?: number;
  resolvedAt?: number;
  resolvedBy?: string;
  note?: string;
}

export interface SleepItem {
  memoryId: string;
  contentPreview: string;
  action: "consolidate" | "archive" | "synthesize";
  reason: string;
  confidence: number;
  accessCount: number;
  ageDays: number;
  idleDays: number;
  expectedLedgerAction: LedgerAction;
}

export interface SleepPreview {
  createdAt: number;
  toConsolidate: string[];
  toArchive: string[];
  toSynthesize: string[][];
  items: SleepItem[];
  /** Records that matched an archive rule but were held back, and why. */
  protected: { memoryId: string; guardrail: string }[];
}

export interface SleepReport {
  backupId: string;
  consolidatedCount: number;
  archivedCount: number;
  synthesizedCount: number;
  actionLog: string[];
  ledgerIds: string[];
}

export type DreamProposalType = "insight" | "domain" | "invariant";

export interface DreamProposal {
  id: string;
  type: DreamProposalType;
  content: string;
  derivedFrom: string[];
  confidence: number;
  suggestedDomain?: string;
  status: "pending_review" | "approved" | "rejected";
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

export interface Embedder {
  readonly dim: number;
  embed(text: string): number[];
}

/** Recommended operational defaults from the spec. */
export const DEFAULTS = {
  retrievalTopN: 5,
  retrievalThreshold: 0.35,
  recencyDays: 14,
  consolidationDays: 7,
  archiveMinDays: 30,
  archiveMaxAccess: 2,
  archiveProtectConfidence: 0.9,
  hubLinks: 3,
  synthesisCosine: 0.82,
  dreamClusterMinSize: 2,
  dreamRelatedness: 0.35,
  maxDreamProposalsPerType: 8,
  conflictAutoResolveGate: 0.7,
  entityCap: 10,
  relatedCap: 5,
  defaultConfidence: 0.7,
} as const;

export const DAY_MS = 24 * 60 * 60 * 1000;

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
