export type Cte = "harvest" | "cooling" | "initial_packing" | "shipping" | "receiving" | "transformation";

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

export interface LocationAction {
  locationId: string;
  locationName: string;
  kind: ActionKind;
  lots: string[];
  rationale: string;
  linkIds: string[];
  contractId: string;
  approval: "not-required" | "pending" | "approved" | "rejected";
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

export interface DraftNotice {
  to: string;
  subject: string;
  body: string;
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
  drafts: DraftNotice[];
  stats: RunStats;
}
