import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CarryoverService,
  Markovian,
  MarkovianConfigError,
  fitStateBlock,
  modelTotals,
  parseMarkers,
  runEfficiency,
} from "../src/index.ts";
import type { Generator } from "../src/index.ts";

const T0 = 1_790_000_000_000;

const checkpoint = (n: number) =>
  `Worked on part ${n}. Therefore part ${n} is settled.\n[STATE_CHECKPOINT]\nCOMPLETED: parts 1-${n}\nREMAINING: parts ${n + 1}-4\nDECISIONS: format=csv; owner=planner\nCONTEXT: entities: DC-EAST`;

/** Scripted generator: returns the given chunk outputs in order and records prompts. */
function scripted(outputs: (string | Error)[]) {
  const prompts: string[] = [];
  const gen: Generator = async (prompt) => {
    prompts.push(prompt);
    const next = outputs[prompts.length - 1];
    if (next instanceof Error) throw next;
    return { text: next ?? "[TASK_COMPLETE]" };
  };
  return { gen, prompts };
}

describe("chunk config", () => {
  it("rejects out-of-range and under-budgeted configs with a typed error", () => {
    const bad = [
      { chunkSize: 128 },
      { chunkSize: 1500, carryoverTokens: 640 }, // 400 framing + 640 + 1200 output > 1500
      { maxChunks: 0 },
      { carryoverTokens: 100 },
      { overlapTokens: 5000 },
      { chunkSize: 4000.5 },
    ];
    for (const chunkConfig of bad) {
      expect(() => new Markovian({ chunkConfig }), JSON.stringify(chunkConfig)).toThrow(MarkovianConfigError);
    }
    expect(() => new Markovian({ chunkConfig: { chunkSize: 8000 }, contextWindow: 4096 })).toThrow(/context window/);
    expect(new Markovian().config).toEqual({ chunkSize: 8000, maxChunks: 24, carryoverTokens: 800, overlapTokens: 0 });
  });

  it("reproduces the documented efficiency table", () => {
    expect(modelTotals(5)).toMatchObject({ naiveTotal: 16_500, markovianTotal: 8_500 });
    expect(modelTotals(10)).toMatchObject({ naiveTotal: 63_000, markovianTotal: 17_000 });
    const eff = runEfficiency([{ tokens: 1000 }, { tokens: 1000 }], { carryoverTokens: 128 });
    expect(eff).toMatchObject({ standardCost: 3000, markovianCost: 2256, tokensSaved: 744 });
  });
});

describe("marker protocol", () => {
  it("parses bracket, legacy and XML markers and cleans them from display text", () => {
    const a = parseMarkers("body text\n[STATE_CHECKPOINT]\nCOMPLETED: x");
    expect(a.cleaned).toBe("body text");
    expect(a.markers.state).toBe("COMPLETED: x");
    expect(parseMarkers("done @@@FINAL@@@").markers.final).toBe(true);
    const x = parseMarkers("work <carryover>DECISIONS: a=1</carryover> more <DONE/>");
    expect(x.markers).toMatchObject({ final: true, state: "DECISIONS: a=1", format: "xml" });
    expect(x.cleaned).not.toMatch(/carryover|DONE/i);
    const t = parseMarkers('need data [NEEDS_TOOL tool="zetaris.query" input="SELECT 1"]');
    expect(t.markers.needsTool).toEqual({ tool: "zetaris.query", input: "SELECT 1" });
    expect(parseMarkers("<CARRYOVER>never closed").errors[0]).toMatch(/malformed/i);
  });
});

describe("compression cascade", () => {
  const config = { chunkSize: 8000, maxChunks: 24, carryoverTokens: 128, overlapTokens: 0 };

  it("walks marker -> compressor -> heuristic -> tail fallback in strict order", async () => {
    const plain = new CarryoverService();
    expect((await plain.next({ markerState: "COMPLETED: step one done; DECISIONS: x=1", previousCarryover: "", chunkText: "", config })).level).toBe(1);
    expect((await plain.next({ markerState: "", previousCarryover: "", chunkText: "Status: lots 1-5 traced. Next: lots 6-10.", config })).level).toBe(3);
    const tail = await plain.next({ markerState: "", previousCarryover: "", chunkText: "word ".repeat(400), config });
    expect(tail.level).toBe(4);
    expect(tail.carryover.length).toBeLessThanOrEqual(128 * 4);

    const withModel = new CarryoverService(async () => "COMPLETED: compressed by the helper model\nDECISIONS: keep csv");
    expect((await withModel.next({ markerState: "", previousCarryover: "", chunkText: "long prose", config })).level).toBe(2);
    const failing = new CarryoverService(async () => {
      throw new Error("compressor offline");
    });
    const fell = await failing.next({ markerState: "", previousCarryover: "", chunkText: "Status: still fine after the outage.", config });
    expect(fell.level).toBe(3);
    expect(fell.warnings.join(" ")).toMatch(/compressor offline/);
  });

  it("drops progress before decisions when the state block overflows", () => {
    const block = [
      `COMPLETED: ${"lot traced; ".repeat(60)}`,
      "REMAINING: 40 lots",
      "DECISIONS: supplier GR01 flagged; window=2026-08-20..2026-10-18",
      "CONTEXT: entities: DC-EAST, DC-WEST",
    ].join("\n");
    const fit = fitStateBlock(block, 64);
    expect(fit.overflow).toBe(true);
    expect(fit.text.length).toBeLessThanOrEqual(64 * 4);
    expect(fit.text).toContain("DECISIONS: supplier GR01 flagged; window=2026-08-20..2026-10-18");
  });
});

describe("run loop", () => {
  it("records per-step history with carryover in and out, and keeps prompts bounded", async () => {
    const { gen, prompts } = scripted([checkpoint(1), checkpoint(2), checkpoint(3), "final part [TASK_COMPLETE]"]);
    const m = new Markovian({ clock: () => T0 });
    const run = await m.run({ goal: "plan the four-part recall drill ".repeat(20), generator: gen, reflect: false });
    expect(run.status).toBe("completed");
    expect(run.chunks.map((c) => c.step)).toEqual([1, 2, 3, 4]);
    expect(run.chunks[1].carryoverIn).toBe(run.chunks[0].carryoverOut);
    expect(run.chunks[0].cascadeLevel).toBe(1);
    expect(prompts[2]).toContain("[CARRYOVER STATE]\nCOMPLETED: parts 1-2");
    // Continuation prompts carry a truncated goal, not the transcript.
    expect(prompts[3]).not.toContain("Worked on part 1");
    expect(Math.max(...prompts.slice(1).map((p) => p.length))).toBeLessThan(prompts[0].length + 400);
    expect(m.history.get(run.id)).toBeDefined();
    expect(m.history.stats().totalRuns).toBe(1);
  });

  it("stops at maxChunks with a structured warning, never a silent truncation", async () => {
    const m = new Markovian({ chunkConfig: { maxChunks: 2 }, clock: () => T0 });
    const run = await m.run({ goal: "never ends", generator: scripted([checkpoint(1), checkpoint(2), checkpoint(3)]).gen });
    expect(run.status).toBe("max-chunks");
    expect(run.warnings.join(" ")).toMatch(/maxChunks/);
    expect(run.reflection).toBeUndefined();
  });

  it("implements the overlap window", async () => {
    const { gen, prompts } = scripted(["alpha beta gamma delta [STATE_CHECKPOINT]\nCOMPLETED: first chunk is done", "[TASK_COMPLETE]"]);
    await new Markovian({ chunkConfig: { overlapTokens: 2 } }).run({ goal: "g", generator: gen, reflect: false });
    // overlapTokens=2 -> the last 8 characters of the previous chunk's cleaned output.
    expect(prompts[1]).toContain("[OVERLAP]\nma delta");
  });

  it("resumes a crashed run from the last checkpoint, across engine instances", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markovian-"));
    const first = scripted([checkpoint(1), checkpoint(2), new Error("provider timeout")]);
    const crashed = await new Markovian({ clock: () => T0, historyDir: dir }).run({ goal: "four parts", generator: first.gen, reflect: false });
    expect(crashed.status).toBe("errored");
    expect(crashed.chunks).toHaveLength(2);

    const second = scripted([checkpoint(3), "[TASK_COMPLETE]"]);
    const m2 = new Markovian({ clock: () => T0, historyDir: dir });
    const done = await m2.resume(crashed.id, { generator: second.gen, reflect: false });
    expect(done.status).toBe("completed");
    expect(done.chunks.map((c) => c.step)).toEqual([1, 2, 3, 4]);
    expect(second.prompts[0]).toContain("COMPLETED: parts 1-2");
    expect(done.resumes).toHaveLength(1);
    expect(done.resumes[0]).toMatchObject({ fromStep: 3, previousStatus: "errored" });
  });

  it("pauses for clarification and resumes with the answer injected", async () => {
    const m = new Markovian({ clock: () => T0 });
    const first = scripted(["Which window? [NEEDS_CLARIFICATION] Use the 14-day or the 60-day window?"]);
    const paused = await m.run({ goal: "pick a window", generator: first.gen });
    expect(paused.status).toBe("paused");
    expect(paused.pending).toEqual({ kind: "clarification", question: "Use the 14-day or the 60-day window?" });
    const second = scripted(["Using 60 days. [TASK_COMPLETE]"]);
    const done = await m.resume(paused.id, { generator: second.gen, stepInput: "60-day", reflect: false });
    expect(done.status).toBe("completed");
    expect(second.prompts[0]).toContain("[CLARIFICATION]\n60-day");
  });

  it("aborts before the next chunk and keeps partial output", async () => {
    const ctl = new AbortController();
    const gen: Generator = async () => {
      ctl.abort();
      return { text: checkpoint(1) };
    };
    const run = await new Markovian().run({ goal: "g", generator: gen, abortSignal: ctl.signal });
    expect(run.status).toBe("aborted");
    expect(run.chunks).toHaveLength(1);
    expect(run.output).toContain("Worked on part 1");
  });

  it("labels provider-reported usage as measured", async () => {
    const gen: Generator = async () => ({ text: "all done [TASK_COMPLETE]", usage: { input_tokens: 900, output_tokens: 42 } });
    const run = await new Markovian().run({ goal: "g", generator: gen, reflect: false });
    expect(run.tokenLabel).toBe("measured");
    expect(run.chunks[0].tokens).toBe(42);
    expect(run.chunks[0].promptTokensIn).toBe(900);
  });
});
