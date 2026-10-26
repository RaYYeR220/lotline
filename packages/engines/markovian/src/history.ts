// Run history: every run with its per-step records, saved after each chunk so
// the last completed chunk is always a resumable checkpoint. In memory by
// default; with a directory, each run is one JSON file under <dir>/runs/,
// written atomically (temp file + rename).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CumulativeStats, MarkovianRun } from "./types.ts";

const EFFICIENCY_HISTORY_CAP = 200;

export class RunHistory {
  private readonly runs = new Map<string, MarkovianRun>();
  private readonly dir?: string;

  constructor(dir?: string) {
    if (!dir) return;
    this.dir = path.join(dir, "runs");
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const run = JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as MarkovianRun;
      this.runs.set(run.id, run);
    }
  }

  /** Checkpoint a run (called after every chunk and at the end of the run). */
  save(run: MarkovianRun): void {
    this.runs.set(run.id, run);
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${safeName(run.id)}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(run, null, 1), "utf8");
    renameSync(tmp, file);
  }

  get(id: string): MarkovianRun | undefined {
    return this.runs.get(id);
  }

  /** Most recent first. */
  list(): MarkovianRun[] {
    return [...this.runs.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  delete(id: string): void {
    this.runs.delete(id);
    if (this.dir) rmSync(path.join(this.dir, `${safeName(id)}.json`), { force: true });
  }

  clear(): void {
    for (const id of [...this.runs.keys()]) this.delete(id);
  }

  stats(): CumulativeStats {
    const finished = this.list()
      .filter((r) => r.status !== "running")
      .reverse();
    const withChunks = finished.filter((r) => r.chunks.length > 0);
    return {
      totalRuns: finished.length,
      completedRuns: finished.filter((r) => r.status === "completed").length,
      totalTokensUsed: finished.reduce((s, r) => s + r.totalTokensUsed, 0),
      totalTokensSaved: finished.reduce((s, r) => s + r.totalTokensSaved, 0),
      averageEfficiency: withChunks.length ? withChunks.reduce((s, r) => s + r.efficiencyPercent, 0) / withChunks.length : 0,
      totalChunksProcessed: finished.reduce((s, r) => s + r.chunks.length, 0),
      lastRunTimestamp: finished.at(-1)?.timestamp ?? 0,
      efficiencyHistory: withChunks
        .slice(-EFFICIENCY_HISTORY_CAP)
        .map((r) => ({ timestamp: r.timestamp, efficiency: r.efficiencyPercent, tokensSaved: r.totalTokensSaved })),
    };
  }

  /**
   * Actual per-step performance across recorded runs. Each run's Markovian
   * step cost uses its own carryover budget from its config snapshot.
   */
  performanceByStep() {
    const acc = new Map<number, { samples: number; tokens: number; standard: number; markovian: number }>();
    for (const run of this.runs.values()) {
      let prefix = 0;
      for (const c of run.chunks) {
        const a = acc.get(c.step) ?? { samples: 0, tokens: 0, standard: 0, markovian: 0 };
        a.samples += 1;
        a.tokens += c.tokens;
        a.standard += prefix + c.tokens;
        a.markovian += run.chunkConfig.carryoverTokens + c.tokens;
        acc.set(c.step, a);
        prefix += c.tokens;
      }
    }
    return [...acc.entries()]
      .sort(([x], [y]) => x - y)
      .map(([step, a]) => {
        const standardCost = a.standard / a.samples;
        const markovianCost = a.markovian / a.samples;
        const savings = Math.max(0, standardCost - markovianCost);
        return {
          step,
          samples: a.samples,
          avgTokens: a.tokens / a.samples,
          standardCost,
          markovianCost,
          savings,
          savingsPercent: standardCost > 0 ? (savings / standardCost) * 100 : 0,
        };
      });
  }
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
