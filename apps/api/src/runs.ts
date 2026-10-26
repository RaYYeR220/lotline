import { randomUUID } from "node:crypto";
import { TraceLog, type RunResult } from "@lotline/core";

export interface RecallInput {
  /** Recall or outbreak notice as free text (FDA enforcement-report style or an email). */
  notice?: string;
  /** An openFDA food enforcement recall number, e.g. F-0123-2026; looked up through the data layer. */
  openFdaRecallNumber?: string;
  /** Point in time to trace as of (ISO date); defaults to now. */
  asOf?: string;
  options?: { maxRetries?: number; panel?: boolean };
}

export type Runner = (input: RecallInput, ctx: { runId: string; trace: TraceLog }) => Promise<RunResult>;

export type ApprovalDecision = "approved" | "rejected";
export type Approver = (record: RunRecord, contractId: string, decision: ApprovalDecision, by: string) => { ok: true } | { ok: false; reason: string };

export interface RunRecord {
  runId: string;
  status: "running" | "complete" | "degraded" | "failed";
  input: RecallInput;
  result?: RunResult;
  error?: string;
  trace: TraceLog;
  startedAt: string;
  finishedAt?: string;
  done: Promise<void>;
}

/** In-process registry of runs; each run streams its trace while it works. */
export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly runner: Runner, private readonly logsDir = process.env.LOGS_DIR ?? "logs") {}

  start(input: RecallInput): RunRecord {
    const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
    const trace = new TraceLog(runId, { dir: this.logsDir });
    const record = { runId, status: "running", input, trace, startedAt: new Date().toISOString() } as RunRecord;
    record.done = this.runner(input, { runId, trace })
      .then((result) => {
        record.result = result;
        record.status = result.status;
      })
      .catch((err: Error) => {
        record.status = "failed";
        record.error = err.message;
        trace.emit({ agent_name: "Orchestrator", action: "run.failed", input_summary: "run", output_summary: err.message.slice(0, 200), status: "error" });
      })
      .finally(() => {
        record.finishedAt = new Date().toISOString();
      });
    this.runs.set(runId, record);
    return record;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  findByContract(contractId: string): RunRecord | undefined {
    return this.list().find((r) => r.result?.actions.some((a) => a.contractId === contractId));
  }
}

/** Public view of a run: everything except the live trace object. */
export function summarize(r: RunRecord) {
  return {
    runId: r.runId,
    status: r.status,
    input: r.input,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? null,
    error: r.error ?? null,
    events: r.trace.events().length,
    result: r.result ?? null,
  };
}
