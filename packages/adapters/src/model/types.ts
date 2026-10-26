import type { z } from "zod";
import type { Lane } from "@lotline/core";

export type { Lane };

export interface ChatReq<T> {
  agent: string;
  lane: Lane;
  purpose: string;
  system: string;
  user: string;
  /** PNG bytes for the vision lane, sent as a data URL. */
  imagePng?: Uint8Array;
  schema: z.ZodType<T>;
  /** Deterministic answer used when no model can answer (sample mode miss, invalid output, outage). */
  ruleFallback: () => T;
  /** Reasoning mode; off by default for latency. */
  thinking?: boolean;
  maxTokens?: number;
  targetAgent?: string;
}

export interface ChatRes<T> {
  model: string;
  lane: Lane;
  json: T;
  raw: string;
  latencyMs: number;
  source: "nightshift" | "cache" | "rules";
  receiptId?: string;
}

export interface PanelReq<T extends { answer: string; why: string }> {
  agent: string;
  purpose: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  lanes: Lane[];
  ruleVote: () => T;
  targetAgent?: string;
}

export interface PanelVote {
  lane: Lane;
  model: string;
  answer: string;
  why: string;
  receiptId?: string;
  source: ChatRes<unknown>["source"];
}

export interface PanelRes {
  outcome: "accepted" | "undecided";
  winner?: string;
  agreement: number;
  votes: PanelVote[];
}

export interface ModelGateway {
  readonly mode: "live" | "sample";
  chat<T>(req: ChatReq<T>): Promise<ChatRes<T>>;
  panel<T extends { answer: string; why: string }>(req: PanelReq<T>): Promise<PanelRes>;
  callCount(): number;
}
