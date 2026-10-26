import type { DataLayer, ModelGateway } from "@lotline/adapters";
import type { LotlineConfig, TraceLog } from "@lotline/core";
import type { WorldModel } from "@lotline/world-model";

/** What the agents remember about partner systems between runs (backed by the H-MEM engine). */
export interface PartnerMemory {
  recallQuirks(source: string): Promise<{ text: string; confidence: number; ledgerRef: string }[]>;
  rememberQuirk(q: { source: string; quirk: string; evidenceRunId: string }): Promise<string>;
  recallRulings(linkKey: string): Promise<{ ruling: string; reason: string; runId: string }[]>;
  rememberRuling(r: { linkKey: string; ruling: "proven" | "unproven" | "rejected"; reason: string; runId: string }): Promise<string>;
}

/** Contract issuing and checking for actions (backed by the Scout Intent engine). */
export interface ActionGate {
  issue(req: {
    intent: "pull" | "hold" | "clear" | "escalate" | "notify";
    target: string;
    args: Record<string, unknown>;
    evidenceLinkIds: string[];
    provenEvidenceCount: number;
    untrustedText?: string[];
  }): { id: string; requiresApproval: boolean; risk: string } | { refused: true; reason: string; detail: string };
  verify(contractId: string): boolean;
  scan(text: string): { flagged: boolean; score: number; signals: string[] };
}

export interface AgentContext {
  cfg: LotlineConfig;
  data: DataLayer;
  models: ModelGateway;
  world: WorldModel;
  memory: PartnerMemory;
  gate: ActionGate;
  trace: TraceLog;
  /** Point in time the trace is evaluated at. */
  asOf: string;
  maxRetries: number;
}
