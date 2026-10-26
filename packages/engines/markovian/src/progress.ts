// Live progress state for UIs and logs: phase, chunk counters, token metrics,
// a bounded log queue and the completed chunks so far. Subscribers get a copy
// on every change; throttling is left to the consumer.

import type { ChunkRecord } from "./types.ts";

export type Phase = "initializing" | "generating" | "compressing" | "reflecting" | "complete" | "error" | "paused";

export interface ProgressState {
  runId?: string;
  isActive: boolean;
  phase: Phase;
  phaseDetail: string;
  currentChunk: number;
  maxChunks: number;
  tokensUsed: number;
  tokensSaved: number;
  carryoverSize: number;
  startTime: number;
  lastUpdateTime: number;
  logs: string[];
  completedChunks: Pick<ChunkRecord, "id" | "tokens" | "carryover" | "content">[];
}

const LOG_CAP = 15;

export class ProgressService {
  private state: ProgressState;
  private readonly listeners = new Set<(s: ProgressState) => void>();

  constructor(private readonly clock: () => number, maxChunks: number) {
    const now = clock();
    this.state = {
      isActive: false,
      phase: "initializing",
      phaseDetail: "",
      currentChunk: 0,
      maxChunks,
      tokensUsed: 0,
      tokensSaved: 0,
      carryoverSize: 0,
      startTime: now,
      lastUpdateTime: now,
      logs: [],
      completedChunks: [],
    };
  }

  get(): ProgressState {
    return structuredClone(this.state);
  }

  subscribe(fn: (s: ProgressState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(runId: string, resumedChunks: ChunkRecord[] = []): void {
    const now = this.clock();
    this.state = {
      ...this.state,
      runId,
      isActive: true,
      phase: "initializing",
      phaseDetail: "",
      currentChunk: resumedChunks.length,
      tokensUsed: resumedChunks.reduce((s, c) => s + c.tokens, 0),
      tokensSaved: 0,
      startTime: now,
      lastUpdateTime: now,
      logs: [],
      completedChunks: resumedChunks.map(({ id, tokens, carryover, content }) => ({ id, tokens, carryover, content })),
    };
    this.emit();
  }

  phase(phase: Phase, detail = ""): void {
    this.state.phase = phase;
    this.state.phaseDetail = detail;
    this.state.isActive = !["complete", "error", "paused"].includes(phase);
    this.log(`${phase}${detail ? `: ${detail}` : ""}`);
  }

  chunkDone(chunk: ChunkRecord, tokensSaved: number): void {
    this.state.currentChunk = chunk.step;
    this.state.completedChunks.push({ id: chunk.id, tokens: chunk.tokens, carryover: chunk.carryover, content: chunk.content });
    this.state.tokensUsed += chunk.tokens;
    this.state.tokensSaved = tokensSaved;
    this.state.carryoverSize = Math.ceil(chunk.carryoverOut.length / 4);
    this.log(`chunk ${chunk.step} done: ${chunk.tokens} tokens, cascade level ${chunk.cascadeLevel}`);
  }

  private log(line: string): void {
    this.state.logs.push(line);
    if (this.state.logs.length > LOG_CAP) this.state.logs.splice(0, this.state.logs.length - LOG_CAP);
    this.state.lastUpdateTime = this.clock();
    this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snap = this.get();
    for (const fn of this.listeners) fn(snap);
  }
}
