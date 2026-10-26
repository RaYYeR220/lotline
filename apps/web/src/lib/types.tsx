// HTTP contract of the Lotline API (mirrors packages/core/src/types.ts).

export interface RecallScope {
  noticeId: string;
  commodity: string;
  productText: string;
  firm?: string;
  lotCodes: string[];
  dateFrom?: string;
  dateTo?: string;
  hazard?: string;
  recallClass?: "I" | "II" | "III";
  uncertainty: string[];
}

export interface Evidence {
  source: string;
  table: string;
  rowKey: string;
  queryId: string;
  sql: string;
  fields: Record<string, string>;
}

export type LinkKind = "harvested-as" | "shipped-to" | "received-as" | "derived-from";
export type LinkStatus = "proposed" | "proven" | "contested" | "unproven" | "rejected";

export interface TraceLink {
  id: string;
  kind: LinkKind;
  from: string;
  to: string;
  at: string;
  quantity?: number;
  evidence: Evidence[];
  status: LinkStatus;
  confidence: number;
  notes: string[];
}

export type ActionKind = "PULL" | "HOLD" | "CLEAR" | "ESCALATE";
export type Approval = "not-required" | "pending" | "approved" | "rejected";

export interface LocationAction {
  locationId: string;
  locationName: string;
  kind: ActionKind;
  lots: string[];
  rationale: string;
  linkIds: string[];
  contractId: string;
  approval: Approval;
}

export type TraceStatus = "success" | "needs_revision" | "retry" | "escalated" | "error" | "skipped";

export interface TraceEvent {
  timestamp: string;
  run_id: string;
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent: string | null;
  model: string | null;
  confidence: number | null;
  retry_count: number;
  status: TraceStatus;
  detail?: Record<string, unknown>;
}

export interface RunStats {
  queries: number;
  modelCalls: number;
  races: number;
  retries: number;
  escalations: number;
  ms: number;
}

export interface RunResult {
  runId: string;
  status: "complete" | "degraded";
  mode: "live" | "sample";
  scope: RecallScope;
  links: TraceLink[];
  actions: LocationAction[];
  spreadsheet: { csv: string; rows: number };
  drafts: { to: string; subject: string; body: string }[];
  stats: RunStats;
}

export interface RunSummary {
  runId: string;
  status: "running" | "complete" | "degraded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  events: number;
  result: RunResult | null;
}

export interface Example {
  id: string;
  title: string;
  notice: string;
}

export interface PanelVote {
  lane: string;
  model: string;
  answer: string;
  why: string;
  receiptId?: string;
  source?: string;
}
