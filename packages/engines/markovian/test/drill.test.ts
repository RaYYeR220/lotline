import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Markovian, resumeDrill, runDrill } from "../src/index.ts";
import type { DrillState } from "../src/index.ts";

const T0 = 1_790_000_000_000;
const lotsOf = (n: number) => Array.from({ length: n }, (_, i) => `GR0${i % 4}-${i + 1}`);
const supplierOf = (lot: string) => lot.split("-")[0];
const isGap = (lot: string) => Number(lot.split("-")[1]) % 3 === 0;

/** A stand-in for the per-lot mini trace: every third lot has no receiving record. */
function fakeStep(calls: string[], failOnce?: string) {
  let failed = false;
  return async (lot: string, s: DrillState): Promise<DrillState> => {
    calls.push(lot);
    if (lot === failOnce && !failed) {
      failed = true;
      throw new Error(`partner system timed out on ${lot}`);
    }
    const sup = supplierOf(lot);
    const cur = s.bySupplier[sup] ?? { ok: 0, gaps: 0 };
    const gap = isGap(lot);
    return {
      traced: s.traced + 1,
      gaps: gap ? [...s.gaps, { lot, reason: "no receiving record" }] : s.gaps,
      bySupplier: { ...s.bySupplier, [sup]: gap ? { ok: cur.ok, gaps: cur.gaps + 1 } : { ok: cur.ok + 1, gaps: cur.gaps } },
    };
  };
}

/** The totals a drill must report: computed directly, lot by lot. */
function expectedTotals(lots: string[]) {
  const bySupplier: Record<string, { ok: number; gaps: number }> = {};
  const gaps: { lot: string; reason: string }[] = [];
  for (const lot of lots) {
    const sup = supplierOf(lot);
    bySupplier[sup] ??= { ok: 0, gaps: 0 };
    if (isGap(lot)) {
      bySupplier[sup].gaps++;
      gaps.push({ lot, reason: "no receiving record" });
    } else bySupplier[sup].ok++;
  }
  return { traced: lots.length, gaps, bySupplier };
}

describe("runDrill", () => {
  it("runs 25 lots in 5 bounded chunks and reports totals equal to the sum of step results", async () => {
    const m = new Markovian({ clock: () => T0 });
    const lots = lotsOf(25);
    const calls: string[] = [];
    const report = await runDrill(m, lots, fakeStep(calls), { chunkSize: 5 });

    expect(report.status).toBe("completed");
    expect(report.chunks).toHaveLength(5);
    expect(report.chunks.map((c) => c.lots)).toEqual([5, 5, 5, 5, 5]);
    expect(calls).toEqual(lots);

    const want = expectedTotals(lots);
    expect(report.traced).toBe(want.traced);
    expect(report.gaps).toEqual(want.gaps);
    expect(report.bySupplier).toEqual(want.bySupplier);
    expect(report.lotsProcessed).toBe(25);

    // Carried state stays within the carryover budget and does not grow with the lot count.
    const carried = report.chunks.slice(0, -1).map((c) => c.carryoverOutTokens);
    for (const t of carried) expect(t).toBeLessThanOrEqual(m.config.carryoverTokens);
    expect(report.chunks[3].carryoverOutChars).toBeLessThan(2 * report.chunks[0].carryoverOutChars);
    // Every chunk after the first resumed from a marker checkpoint, not a fallback.
    expect(report.chunks.slice(0, -1).every((c) => c.cascadeLevel === 1)).toBe(true);
    expect(report.tokens.label).toBe("estimated");
    expect(report.tokens.used).toBeGreaterThan(0);
  });

  it("keeps carried state flat over a long drill", async () => {
    const m = new Markovian({ clock: () => T0 });
    const report = await runDrill(m, lotsOf(200), fakeStep([]), { chunkSize: 10 });
    expect(report.chunks).toHaveLength(20);
    const sizes = report.chunks.slice(4, -1).map((c) => c.carryoverOutChars);
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.15);
    expect(report.traced).toBe(200);
    expect(report.gaps).toHaveLength(66);
  });

  it("resumes from the last checkpoint after a step throws in chunk 3", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "drill-"));
    const lots = lotsOf(25);
    const calls: string[] = [];
    const step = fakeStep(calls, "GR00-13");

    const crashed = await runDrill(new Markovian({ clock: () => T0, historyDir: dir }), lots, step, { chunkSize: 5 });
    expect(crashed.status).toBe("errored");
    expect(crashed.error).toMatch(/GR00-13/);
    expect(crashed.chunks).toHaveLength(2);
    expect(crashed.lotsProcessed).toBe(10);

    // A fresh engine over the same history directory picks the run up again.
    const resumed = await resumeDrill(new Markovian({ clock: () => T0, historyDir: dir }), crashed.runId, step);
    expect(resumed.runId).toBe(crashed.runId);
    expect(resumed.status).toBe("completed");
    expect(resumed.resumed).toBe(1);
    expect(resumed.chunks).toHaveLength(5);

    // Lots 1-10 ran once; chunk 3 restarted at lot 11 from the checkpoint.
    expect(calls.filter((l) => l === "GR00-1")).toHaveLength(1);
    expect(calls.filter((l) => l === "GR02-11")).toHaveLength(2);

    const want = expectedTotals(lots);
    expect(resumed.traced).toBe(want.traced);
    expect(resumed.gaps).toEqual(want.gaps);
    expect(resumed.bySupplier).toEqual(want.bySupplier);
  });

  it("rejects a drill that cannot fit in maxChunks instead of truncating it", async () => {
    const m = new Markovian({ chunkConfig: { maxChunks: 4 }, clock: () => T0 });
    await expect(runDrill(m, lotsOf(25), fakeStep([]), { chunkSize: 5 })).rejects.toThrow(/maxChunks/);
  });
});
