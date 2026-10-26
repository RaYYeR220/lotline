import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HMEM, HashEmbedder, cosine } from "../src/index.ts";

const T0 = 1_790_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const tempDir = () => mkdtempSync(path.join(tmpdir(), "hmem-engine-"));

describe("records and provenance", () => {
  it("rejects records without a source or content and derives provenance for every write", () => {
    const m = new HMEM({ clock: () => T0 });
    expect(() => m.add({ content: "x", source: "  " })).toThrow(/source/);
    expect(() => m.add({ content: "", source: "test" })).toThrow(/content/);
    expect(() => m.add({ content: "x", source: "test", confidence: 1.5 })).toThrow(/confidence/);
    const r = m.add({ content: "packer.shipments output_lot is the PK code", source: "run:run-1" });
    expect(r.provenance).toMatchObject({ learnedAt: T0 });
    expect(r.provenance.label.length).toBeGreaterThan(0);
    expect(r.layer).toBe("working");
    expect(r.entities.map((e) => e.name)).toEqual(expect.arrayContaining(["packer.shipments", "output_lot"]));
  });

  it("the local embedder is deterministic and puts paraphrases closer than unrelated text", () => {
    const e = new HashEmbedder();
    const a = e.embed("vendor lot codes use dashes");
    expect(e.embed("vendor lot codes use dashes")).toEqual(a);
    const near = cosine(a, e.embed("the vendor lot code uses dashes"));
    const far = cosine(a, e.embed("store fourteen received romaine on tuesday"));
    expect(near).toBeGreaterThan(far);
  });
});

describe("hybrid retrieval", () => {
  it("ranks, reinjects domain-grouped context, logs reads and suppresses superseded records", () => {
    let now = T0;
    const m = new HMEM({ clock: () => now });
    const oldRec = m.add({ content: "wms.lpn maps an LPN to the vendor lot", source: "run:1", layer: "long_term" });
    const newRec = m.add({ content: "wms.lpn maps an LPN to the vendor lot and the receiving date", source: "run:2", layer: "long_term" });
    m.add({ content: "the office coffee machine is broken", source: "chat" });
    m.store.supersede(oldRec.id, newRec.id, { reason: "richer mapping" });
    now += DAY;
    const res = m.query("which table maps an LPN to the vendor lot", { threshold: 0.1 });
    expect(res.memories[0].memory.id).toBe(newRec.id);
    expect(res.trace.suppressed).toContain(oldRec.id);
    expect(res.context).toMatch(/\[MEMORY CONTEXT\]/);
    expect(res.context).toMatch(/## partner-data/);
    expect(m.ledger.history(newRec.id).some((e) => e.action === "read")).toBe(true);
    expect(m.store.get(newRec.id)!.accessCount).toBe(1);
  });

  it("goal-run scoped memories never leak into another run", () => {
    const m = new HMEM({ clock: () => T0 });
    m.add({ content: "lot PK260901003 is implicated", source: "run:a", goalRunId: "run-a" });
    m.add({ content: "lot PK260901003 is cleared", source: "run:b", goalRunId: "run-b" });
    const res = m.query("lot PK260901003", { threshold: 0, goalRunId: "run-a" });
    expect(res.memories.map((r) => r.memory.goalRunId)).toEqual(["run-a"]);
  });
});

describe("trust ledger", () => {
  it("is append-only on disk and records feedback with exact deltas", () => {
    const dir = tempDir();
    const m = new HMEM({ clock: () => T0, dir });
    const r = m.add({ content: "retail.receipts uses chain-prefixed lots", source: "run:1", confidence: 0.6 });
    m.feedback(r.id, "helpful");
    m.feedback(r.id, "wrong");
    const lines = readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.action)).toEqual(["create", "feedback", "feedback"]);
    expect(lines[2].previousState.confidence).toBeCloseTo(0.65, 10);
    expect(lines[2].newState.confidence).toBeCloseTo(0.45, 10);
    expect(new HMEM({ dir }).store.get(r.id)!.tags).toContain("review");
  });

  it("keeps short-term memory out of the file store", () => {
    const dir = tempDir();
    const m = new HMEM({ clock: () => T0, dir });
    m.add({ content: "scratch note for this session", source: "chat", layer: "short_term" });
    const kept = m.add({ content: "durable note", source: "chat", layer: "long_term" });
    expect(new HMEM({ dir }).store.all().map((r) => r.id)).toEqual([kept.id]);
  });
});

describe("sleep cycle", () => {
  it("previews without mutating, executes only the preview, and restores from backup", () => {
    let now = T0;
    const dir = tempDir();
    const m = new HMEM({ clock: () => now, dir });
    const stale = m.add({ content: "one-off note about a parking permit", source: "chat" });
    const a = m.add({ content: "always rinse romaine before packing", source: "run:1" });
    const b = m.add({ content: "never rinse romaine before packing", source: "run:2" });
    m.conflicts.scan();
    now += 40 * DAY;

    const ledgerBefore = m.ledger.all().length;
    const preview = m.sleep.preview();
    expect(m.ledger.all().length).toBe(ledgerBefore);
    expect(preview.toArchive).toContain(stale.id);
    // Records in an open conflict are guardrail-protected.
    expect(preview.toArchive).not.toContain(a.id);
    expect(preview.protected.find((p) => p.memoryId === b.id)?.guardrail).toMatch(/conflict/);

    const report = m.sleep.execute(preview);
    expect(report.archivedCount).toBe(1);
    expect(m.store.get(stale.id)).toBeUndefined();
    expect(report.ledgerIds.length).toBeGreaterThan(0);

    m.sleep.restore(report.backupId);
    expect(m.store.get(stale.id)?.content).toBe(stale.content);
    expect(m.ledger.all().at(-1)?.action).toBe("restore");
    expect(new HMEM({ dir }).store.get(stale.id)).toBeDefined();
  });
});

describe("dreaming", () => {
  it("proposes without applying, logs rejections, and materializes approvals with lineage", () => {
    const m = new HMEM({ clock: () => T0 });
    m.add({ content: "prefer the FDA spreadsheet sorted by location", source: "chat", type: "preference" });
    m.add({ content: "prefer the FDA spreadsheet with one row per lot", source: "chat", type: "preference" });
    const count = m.store.all().length;
    const proposals = m.dreaming.dream();
    expect(proposals.length).toBeGreaterThan(0);
    expect(m.store.all().length).toBe(count);
    expect(proposals.every((p) => p.status === "pending_review")).toBe(true);
    // Dreaming the same memories again does not duplicate proposals.
    expect(m.dreaming.dream()).toEqual([]);

    const invariant = proposals.find((p) => p.type === "invariant")!;
    const created = m.dreaming.approve(invariant.id)!;
    expect(created.layer).toBe("long_term");
    expect(created.type).toBe("preference");
    expect(created.derivedFrom.length).toBe(2);

    const other = proposals.find((p) => p.id !== invariant.id);
    if (other) {
      m.dreaming.reject(other.id);
      expect(m.ledger.history(other.id).map((e) => e.action)).toEqual(["dream_proposed", "dream_rejected"]);
    }
  });
});
