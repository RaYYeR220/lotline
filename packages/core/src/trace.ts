import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { TraceEvent, TraceStatus } from "./types.ts";

export type TraceInput = {
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  status: TraceStatus;
  target_agent?: string | null;
  model?: string | null;
  confidence?: number | null;
  retry_count?: number;
  detail?: Record<string, unknown>;
};

/** Append-only run trace: JSONL on disk, optional stdout, in-memory copy for the API stream. */
export class TraceLog {
  readonly runId: string;
  private readonly file: string;
  private readonly stdout: boolean;
  private readonly all: TraceEvent[] = [];
  private readonly listeners = new Set<(e: TraceEvent) => void>();

  constructor(runId: string, opts: { dir?: string; stdout?: boolean } = {}) {
    this.runId = runId;
    const dir = opts.dir ?? process.env.LOGS_DIR ?? "logs";
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${runId}.jsonl`);
    this.stdout = opts.stdout ?? true;
  }

  emit(input: TraceInput): TraceEvent {
    const event: TraceEvent = {
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      agent_name: input.agent_name,
      action: input.action,
      input_summary: input.input_summary,
      output_summary: input.output_summary,
      target_agent: input.target_agent ?? null,
      model: input.model ?? null,
      confidence: input.confidence ?? null,
      retry_count: input.retry_count ?? 0,
      status: input.status,
      ...(input.detail ? { detail: input.detail } : {}),
    };
    this.all.push(event);
    const line = JSON.stringify(event);
    appendFileSync(this.file, line + "\n");
    if (this.stdout) process.stdout.write(line + "\n");
    for (const fn of this.listeners) fn(event);
    return event;
  }

  events(): TraceEvent[] {
    return [...this.all];
  }

  subscribe(fn: (e: TraceEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
