// The Markovian engine: runs a long task as a chain of bounded chunks. Each
// chunk sees only a goal summary plus the carried state, never the transcript,
// so per-step context stays flat. After every chunk the run is checkpointed to
// history; a crashed, paused or aborted run resumes from its last chunk.

import { randomUUID } from "node:crypto";
import { CarryoverService, STATE_LABELS, parseStateBlock } from "./carryover.ts";
import { estimateTokens, resolveChunkConfig, runEfficiency } from "./config.ts";
import { RunHistory } from "./history.ts";
import { cleanMarkers, parseMarkers } from "./markers.ts";
import { ProgressService } from "./progress.ts";
import type { ProgressState } from "./progress.ts";
import { buildPrompt, overlapSlice } from "./prompt.ts";
import type {
  ChunkConfig, ChunkRecord, CompressorFn, Generator, MarkovianRun, Mode, ReflectionMode, ReflectionResult,
  ResumeOptions, RunOptions, RunStatus,
} from "./types.ts";

export interface MarkovianOptions {
  chunkConfig?: Partial<ChunkConfig> & { tokensPerChunk?: number };
  clock?: () => number;
  /** Default generator for runs that do not pass one. */
  generator?: Generator;
  /** Model hook for rung 2 of the compression cascade. */
  compressorFn?: CompressorFn;
  /** Persist run history (and so checkpoints) under this directory. */
  historyDir?: string;
  /** Model context window; the config must fit inside it. */
  contextWindow?: number;
  mode?: Mode;
  idFactory?: () => string;
}

const RESUMABLE: readonly RunStatus[] = ["errored", "paused", "aborted"];
const REFLECTION_CHARS = 30_000;

export class Markovian {
  readonly config: ChunkConfig;
  readonly history: RunHistory;
  readonly progress: ProgressService;
  private readonly carryover: CarryoverService;
  private readonly clock: () => number;
  private readonly defaultGenerator?: Generator;
  private readonly defaultMode: Mode;
  private readonly newId: () => string;

  constructor(opts: MarkovianOptions = {}) {
    this.config = resolveChunkConfig(opts.chunkConfig, { contextWindow: opts.contextWindow });
    this.clock = opts.clock ?? Date.now;
    this.history = new RunHistory(opts.historyDir);
    this.progress = new ProgressService(this.clock, this.config.maxChunks);
    this.carryover = new CarryoverService(opts.compressorFn);
    this.defaultGenerator = opts.generator;
    this.defaultMode = opts.mode ?? "ARCHITECT";
    this.newId = opts.idFactory ?? randomUUID;
  }

  onProgress(fn: (s: ProgressState) => void): () => void {
    return this.progress.subscribe(fn);
  }

  async run(options: RunOptions): Promise<MarkovianRun> {
    const goal = options.goal ?? options.prompt;
    if (!goal) throw new Error("Markovian: a run needs a goal");
    const generator = this.resolveGenerator(options, goal);
    const now = this.clock();
    const run: MarkovianRun = {
      id: this.newId(),
      goal,
      prompt: goal.slice(0, 500),
      mode: options.mode ?? this.defaultMode,
      chunkConfig: { ...this.config },
      chunks: [],
      totalTokensUsed: 0,
      totalTokensSaved: 0,
      efficiencyPercent: 0,
      durationMs: 0,
      timestamp: now,
      startedAt: new Date(now).toISOString(),
      status: "running",
      tokenLabel: "estimated",
      output: "",
      errors: [],
      warnings: [],
      resumes: [],
      ...(options.carryover ? { initialCarryover: options.carryover } : {}),
      ...(options.meta ? { meta: options.meta } : {}),
    };
    this.history.save(run);
    return this.execute(run, generator, options);
  }

  /**
   * Continue an errored, paused or aborted run from its last checkpoint (the
   * carryover of its last completed chunk). A paused run needs `stepInput`:
   * the tool result or the human answer it was waiting for.
   */
  async resume(runId: string, options: ResumeOptions = {}): Promise<MarkovianRun> {
    const run = this.history.get(runId);
    if (!run) throw new Error(`Markovian: unknown run ${runId}`);
    if (!RESUMABLE.includes(run.status)) throw new Error(`Markovian: a ${run.status} run cannot be resumed`);
    const generator = this.resolveGenerator(options, run.goal);

    let injected: string | undefined;
    if (run.status === "paused") {
      if (options.stepInput === undefined) throw new Error("Markovian: resuming a paused run needs stepInput");
      injected = run.pending?.kind === "tool"
        ? `[TOOL RESULT tool="${run.pending.tool}"]\n${options.stepInput}`
        : `[CLARIFICATION]\n${options.stepInput}`;
    }
    run.resumes.push({ at: this.clock(), fromStep: run.chunks.length + 1, previousStatus: run.status });
    run.status = "running";
    delete run.error;
    delete run.pending;
    return this.execute(run, generator, options, injected);
  }

  /** Line-level diff of two carryovers: what a step learned, dropped and kept. */
  diff(before: string, after: string): { added: string[]; removed: string[]; retained: string[] } {
    const a = stateItems(before);
    const b = stateItems(after);
    return {
      added: [...b].filter((x) => !a.has(x)),
      removed: [...a].filter((x) => !b.has(x)),
      retained: [...a].filter((x) => b.has(x)),
    };
  }

  private async execute(run: MarkovianRun, generator: Generator, options: RunOptions | ResumeOptions, injected?: string): Promise<MarkovianRun> {
    const cfg = run.chunkConfig;
    const started = this.clock();
    const last = run.chunks.at(-1);
    let carryover = last ? last.carryoverOut : (run.initialCarryover ?? "");
    let previousCleaned = last?.content ?? "";
    let liveSavings = 0;
    let done = false;
    const abort = options.abortSignal;
    this.progress.start(run.id, run.chunks);
    this.progress.phase("initializing", `${run.mode} chain, step ${run.chunks.length + 1}, maxChunks=${cfg.maxChunks}`);

    try {
      while (!done && run.chunks.length < cfg.maxChunks) {
        if (abort?.aborted) {
          run.status = "aborted";
          break;
        }
        const step = run.chunks.length + 1;
        this.progress.phase("generating", `chunk ${step}`);
        const prompt = buildPrompt({
          mode: run.mode,
          goal: run.goal,
          step,
          carryover,
          overlap: overlapSlice(previousCleaned, cfg),
          memoryContext: options.memoryContext,
          attachments: step === 1 ? options.attachments : undefined,
          injected,
          config: cfg,
        });
        const t0 = this.clock();
        const result = await generator(prompt, step === 1 ? (options.attachments ?? []) : [], options.systemPrompt, options.onStream, abort, {
          runId: run.id,
          step,
          carryover,
          meta: run.meta,
        });
        injected = undefined;
        if (!result || typeof result.text !== "string") throw new Error(`generator returned no text at step ${step}`);

        const parsed = parseMarkers(result.text);
        const measuredOut = result.usage?.output_tokens;
        const measured = typeof measuredOut === "number";
        const tokens = measured ? measuredOut : estimateTokens(parsed.cleaned);
        const chunk: ChunkRecord = {
          id: step,
          step,
          tokens,
          carryover,
          content: parsed.cleaned,
          prompt,
          output: result.text,
          markers: parsed.markers,
          carryoverIn: carryover,
          carryoverOut: carryover,
          cascadeLevel: 4,
          promptTokensIn: result.usage?.input_tokens ?? estimateTokens(prompt),
          outputTokensOut: tokens,
          tokenLabel: measured ? "measured" : "estimated",
          latencyMs: this.clock() - t0,
          warnings: [...parsed.warnings],
        };
        for (const e of parsed.errors) run.errors.push(`step ${step}: ${e}`);

        // Live savings estimate: full history would have cost (step-1) x chunkSize more.
        liveSavings += Math.max(0, (step - 1) * cfg.chunkSize + tokens - (cfg.carryoverTokens + tokens));

        if (abort?.aborted) {
          // The chunk is already paid for: keep it, skip compression, stop.
          this.commit(run, chunk, liveSavings);
          run.status = "aborted";
          break;
        }

        this.progress.phase("compressing", `chunk ${step}`);
        const next = await this.carryover.next({ markerState: parsed.markers.state, previousCarryover: carryover, chunkText: result.text, config: cfg });
        chunk.carryoverOut = next.carryover;
        chunk.cascadeLevel = next.level;
        chunk.warnings.push(...next.warnings);
        this.commit(run, chunk, liveSavings);
        carryover = chunk.carryoverOut;
        previousCleaned = chunk.content;

        const { needsTool, needsClarification, final } = parsed.markers;
        if (needsTool) {
          if (!options.onTool) {
            this.pause(run, { kind: "tool", tool: needsTool.tool, input: needsTool.input });
            break;
          }
          const toolResult = await options.onTool(needsTool.tool, needsTool.input);
          chunk.toolCalls = [{ ...needsTool, result: toolResult }];
          injected = `[TOOL RESULT tool="${needsTool.tool}"]\n${toolResult}`;
          this.history.save(run);
        } else if (needsClarification !== undefined) {
          this.pause(run, { kind: "clarification", question: needsClarification });
          break;
        }
        if (final) done = true;
        else if (options.stopWhen?.({ step, carryover })) done = true;
      }

      if (run.status === "running") {
        if (done) run.status = "completed";
        else {
          run.status = "max-chunks";
          run.warnings.push(`stopped at maxChunks=${cfg.maxChunks} without [TASK_COMPLETE]; partial output kept`);
        }
      }
    } catch (err) {
      run.status = "errored";
      run.error = (err as Error).message;
      run.errors.push(`step ${run.chunks.length + 1}: ${run.error}`);
    }

    this.finalize(run);
    if (run.status === "completed" && run.chunks.length > 0 && options.reflect !== false && !abort?.aborted) {
      const mode: ReflectionMode = typeof options.reflect === "object" ? options.reflect.mode : "conclude";
      this.progress.phase("reflecting", mode);
      try {
        run.reflection = await this.reflect(run, generator, mode, carryover, abort);
      } catch (err) {
        // Reflection never fails the run.
        run.reflection = { mode, verdict: "skipped", error: (err as Error).message };
        run.warnings.push(`reflection failed (run preserved): ${(err as Error).message}`);
      }
    }
    run.durationMs += this.clock() - started;
    run.endedAt = new Date(this.clock()).toISOString();
    this.progress.phase(run.status === "errored" ? "error" : run.status === "paused" ? "paused" : "complete", run.status);
    this.history.save(run);
    return run;
  }

  // Persist a finished chunk: this is the checkpoint a resume starts from.
  private commit(run: MarkovianRun, chunk: ChunkRecord, liveSavings: number): void {
    run.chunks.push(chunk);
    this.finalize(run);
    this.progress.chunkDone(chunk, liveSavings);
    this.history.save(run);
  }

  private pause(run: MarkovianRun, pending: NonNullable<MarkovianRun["pending"]>): void {
    run.status = "paused";
    run.pending = pending;
  }

  // Totals are always recomputed from the chunks and the run's own config snapshot.
  private finalize(run: MarkovianRun): void {
    const eff = runEfficiency(run.chunks, run.chunkConfig);
    run.totalTokensUsed = eff.totalTokensUsed;
    run.totalTokensSaved = eff.tokensSaved;
    run.efficiencyPercent = eff.efficiencyPercent;
    run.tokenLabel = run.chunks.length > 0 && run.chunks.every((c) => c.tokenLabel === "measured") ? "measured" : "estimated";
    run.output = run.chunks.map((c) => c.content).filter(Boolean).join("\n\n");
  }

  private async reflect(run: MarkovianRun, generator: Generator, mode: ReflectionMode, finalState: string, abort?: AbortSignal): Promise<ReflectionResult> {
    const codeBlocks = Math.floor((run.output.match(/```/g)?.length ?? 0) / 2);
    const ask: Record<ReflectionMode, string> = {
      conclude: "Synthesize a final review. Highlight what was accomplished, what was deferred, and what should be tested first.",
      ratify: "Reply RATIFIED: <reason> if the output is coherent with the goal; otherwise FLAGGED: followed by one issue per line starting with \"- \".",
      refine: "List issues under \"issues:\" (one per line starting with \"- \"), then write \"refined_output:\" followed by the corrected final output.",
    };
    const prompt = [
      `[REFLECTION ${mode.toUpperCase()}]`,
      `Goal: ${run.goal.slice(0, 200)}`,
      `Final state:\n${finalState}`,
      `Code blocks: ${codeBlocks}`,
      `Output (truncated):\n${run.output.slice(0, REFLECTION_CHARS)}`,
      ask[mode],
    ].join("\n\n");
    const { text } = await generator(prompt, [], "You are the reflection pass. Be brief and concrete.", undefined, abort, {
      runId: run.id,
      step: run.chunks.length + 1,
      carryover: finalState,
      meta: run.meta,
    });
    const clean = cleanMarkers(text);
    const issues = clean.split("\n").filter((l) => /^\s*-\s+/.test(l)).map((l) => l.replace(/^\s*-\s+/, "").trim());
    if (mode === "conclude") return { mode, verdict: "concluded", text: clean };
    if (mode === "ratify") return { mode, verdict: /\bFLAGGED\b/i.test(clean) ? "flagged" : "ratified", text: clean, issues };
    const refined = /refined_output:\s*([\s\S]*)$/i.exec(clean)?.[1]?.trim();
    if (!refined) return { mode, verdict: issues.length ? "flagged" : "ratified", text: clean, issues };
    const originalOutput = run.output;
    run.output = refined;
    return { mode, verdict: "refined", text: clean, issues, originalOutput };
  }

  private resolveGenerator(options: RunOptions | ResumeOptions, goal: string): Generator {
    if (options.generator) return options.generator;
    const stepFn = options.stepFn;
    if (stepFn) {
      return async (prompt, _attachments, _system, _stream, _abort, extras) => {
        const r = await stepFn({ goal, carryover: extras?.carryover ?? "", step: extras?.step ?? 1, prompt });
        return { text: typeof r === "string" ? r : r.content };
      };
    }
    if (this.defaultGenerator) return this.defaultGenerator;
    throw new Error("Markovian: provide a generator or a stepFn");
  }
}

function stateItems(text: string): Set<string> {
  const block = parseStateBlock(text);
  if (!block) return new Set(text.split(/;\s+|\n+/).map((s) => s.trim()).filter(Boolean));
  return new Set(STATE_LABELS.flatMap((l) => block[l].map((item) => `${l}: ${item}`)));
}
