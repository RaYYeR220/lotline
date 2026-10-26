// Chunk prompts. Chunk 1 gets the full goal, memory context and attachments;
// every later chunk gets a ~200-char goal summary, the carried state, the
// optional overlap window and any injected tool result or clarification,
// so prompt size stays flat however long the chain runs.

import { OUTPUT_BUDGET } from "./config.ts";
import type { Attachment, ChunkConfig, Mode } from "./types.ts";

const GOAL_SUMMARY_CHARS = 200;

const FIRST: Record<Mode, string> = {
  ARCHITECT: "Analyse the goal, plan the approach and start on the first part. Work in one focused step.",
  RESEARCH:
    "Research the goal step by step. Log each action on its own line starting with \">> \" and keep a short " +
    "research-tree snapshot in your state block.",
};

const NEXT: Record<Mode, string> = {
  ARCHITECT: "Continue from the carried state. Do not repeat finished work; take the next focused step.",
  RESEARCH: "Resume the research from the carried state. Keep logging actions with \">> \"; do not repeat finished branches.",
};

function markerRules(config: ChunkConfig): string {
  return [
    `Keep this step under ~${OUTPUT_BUDGET} tokens and end it with exactly one marker:`,
    `- work remains: [STATE_CHECKPOINT] then four lines COMPLETED: / REMAINING: / DECISIONS: / CONTEXT: (at most ~${config.carryoverTokens} tokens; keep decisions with their values)`,
    "- task finished: [TASK_COMPLETE]",
    '- tool needed: [NEEDS_TOOL tool="name" input="..."]',
    "- human answer needed: [NEEDS_CLARIFICATION] followed by the question",
  ].join("\n");
}

export interface PromptArgs {
  mode: Mode;
  goal: string;
  step: number;
  carryover: string;
  overlap?: string;
  memoryContext?: string;
  attachments?: Attachment[];
  /** Tool result or clarification answer for a resumed pause. */
  injected?: string;
  config: ChunkConfig;
}

export function buildPrompt(a: PromptArgs): string {
  const header = `[MARKOVIAN ${a.mode} | step ${a.step} of at most ${a.config.maxChunks}]`;
  const parts: string[] = [header];
  const fresh = a.step === 1 && !a.carryover;

  if (fresh) {
    parts.push(a.memoryContext ? `${a.memoryContext}\n\nUser Request: ${a.goal}` : a.goal);
  } else {
    const summary = a.goal.length > GOAL_SUMMARY_CHARS ? `${a.goal.slice(0, GOAL_SUMMARY_CHARS - 3)}...` : a.goal;
    parts.push(`Goal (summary): ${summary}`);
    if (a.step === 1 && a.memoryContext) parts.push(a.memoryContext);
    parts.push(`[CARRYOVER STATE]\n${a.carryover}`);
  }
  if (a.overlap) parts.push(`[OVERLAP]\n${a.overlap}`);
  if (a.injected) parts.push(a.injected);
  if (a.step === 1 && a.attachments?.length) {
    parts.push(`[ATTACHMENTS]\n${a.attachments.map((x) => `--- ${x.name}\n${x.content}`).join("\n")}`);
  }
  parts.push(fresh ? FIRST[a.mode] : NEXT[a.mode]);
  parts.push(markerRules(a.config));
  return parts.join("\n\n");
}

/** The last `overlapTokens` (x4 chars) of the previous chunk's cleaned output. */
export function overlapSlice(previousCleaned: string, config: ChunkConfig): string {
  if (config.overlapTokens <= 0 || !previousCleaned) return "";
  return previousCleaned.slice(-config.overlapTokens * 4);
}
