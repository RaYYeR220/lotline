import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TraceLog } from "@lotline/core";
import { HMEM, recallQuirks, recallRulings, rememberQuirk, rememberRuling } from "../src/index.ts";

const DASHES = "wms.receiving vendor_lot uses dashes: PK-yyMMdd-seq";
const NO_DASHES = "wms.receiving vendor_lot uses no dashes: PKyyMMddseq";

const tempDir = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));

describe("partner quirks across runs", () => {
  it("a quirk learned in run 1 is recalled by a fresh instance over the same file store, with its ledger ref", async () => {
    const dir = tempDir("hmem-");
    const run1 = new HMEM({ dir });
    const id = await rememberQuirk(run1, { source: "wms.receiving", quirk: DASHES, evidenceRunId: "run-1" });

    // Run 2: a brand-new process would build a new HMEM over the same directory.
    const run2 = new HMEM({ dir });
    const trace = new TraceLog("run-2", { dir: tempDir("trace-"), stdout: false });
    const quirks = await recallQuirks(run2, "wms.receiving", { trace, agent: "SourceMapperAgent" });

    expect(quirks).toHaveLength(1);
    expect(quirks[0].text).toBe(DASHES);
    expect(quirks[0].memoryId).toBe(id);
    expect(quirks[0].confidence).toBeGreaterThan(0.5);
    expect(quirks[0].contested).toBe(false);

    // The ledger ref points at the append-only entry that recorded how it was learned.
    const entry = run2.ledger.get(quirks[0].ledgerRef);
    expect(entry?.action).toBe("create");
    expect(entry?.memoryId).toBe(id);
    expect(entry?.newState?.provenance?.refs?.goalRunId).toBe("run-1");
    expect(existsSync(path.join(dir, "ledger.jsonl"))).toBe(true);
    expect(existsSync(path.join(dir, "memories.jsonl"))).toBe(true);

    const events = trace.events();
    expect(events).toHaveLength(1);
    expect(events[0].agent_name).toBe("SourceMapperAgent");
    expect(events[0].action).toBe("hmem.recall");
    expect(events[0].detail?.ledgerRefs).toEqual([quirks[0].ledgerRef]);
  });

  it("recall is scoped to the partner source", async () => {
    const m = new HMEM({ dir: tempDir("hmem-") });
    await rememberQuirk(m, { source: "wms.receiving", quirk: DASHES, evidenceRunId: "run-1" });
    await rememberQuirk(m, { source: "retail.receipts", quirk: "retail.receipts lot codes drop separators and prefix the chain", evidenceRunId: "run-1" });
    const wms = await recallQuirks(m, "wms.receiving");
    const retail = await recallQuirks(m, "retail.receipts");
    expect(wms.map((q) => q.text)).toEqual([DASHES]);
    expect(retail).toHaveLength(1);
    expect(retail[0].text).toMatch(/prefix the chain/);
  });

  it("re-observing the same quirk reinforces the record instead of duplicating it", async () => {
    const m = new HMEM({ dir: tempDir("hmem-") });
    const a = await rememberQuirk(m, { source: "wms.receiving", quirk: DASHES, evidenceRunId: "run-1" });
    const before = m.store.get(a)!.confidence;
    const b = await rememberQuirk(m, { source: "wms.receiving", quirk: DASHES, evidenceRunId: "run-2" });
    expect(b).toBe(a);
    expect(m.store.all()).toHaveLength(1);
    expect(m.store.get(a)!.confidence).toBeGreaterThan(before);
    const actions = m.ledger.history(a).map((e) => e.action);
    expect(actions).toEqual(["create", "update"]);
    expect(m.ledger.history(a)[1].details?.evidenceRunId).toBe("run-2");
  });

  it("a contradicting quirk creates a conflict record, never a silent overwrite", async () => {
    const dir = tempDir("hmem-");
    const m = new HMEM({ dir });
    const first = await rememberQuirk(m, { source: "wms.receiving", quirk: DASHES, evidenceRunId: "run-1" });
    const second = await rememberQuirk(m, { source: "wms.receiving", quirk: NO_DASHES, evidenceRunId: "run-2" });

    expect(second).not.toBe(first);
    expect(m.store.get(first)!.content).toBe(DASHES);
    expect(m.store.get(second)!.content).toBe(NO_DASHES);

    const conflicts = m.conflicts.forMemory(first);
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0];
    expect([c.memoryA, c.memoryB].sort()).toEqual([first, second].sort());
    // Two equally trusted observations: below the auto-resolve gate, so it is queued for review.
    expect(c.status).toBe("open");
    expect(m.store.get(first)!.supersededBy).toBeUndefined();
    expect(m.ledger.history(first).some((e) => e.action === "conflict_detected")).toBe(true);

    const recalled = await recallQuirks(m, "wms.receiving");
    expect(recalled).toHaveLength(2);
    expect(recalled.every((q) => q.contested)).toBe(true);

    // The conflict survives a restart.
    const reopened = new HMEM({ dir });
    expect(reopened.conflicts.open().map((x) => x.id)).toEqual([c.id]);

    // A reviewer resolves it on the record: the loser is superseded, kept, and audited.
    reopened.conflicts.resolve(c.id, c.memoryA === second ? "keep_a" : "keep_b", { actor: "reviewer:qa" });
    const resolved = reopened.conflicts.get(c.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.winner).toBe(second);
    expect(reopened.store.get(first)!.supersededBy).toBe(second);
    const audit = reopened.ledger.history(first).find((e) => e.action === "conflict_resolved");
    expect(audit?.previousState?.supersededBy).toBeUndefined();
    expect(audit?.newState?.supersededBy).toBe(second);
    expect(audit?.actor).toBe("reviewer:qa");

    const after = await recallQuirks(reopened, "wms.receiving");
    expect(after.map((q) => q.text)).toEqual([NO_DASHES]);
    expect(reopened.store.get(first)).toBeDefined();
  });
});

describe("prior rulings on trace links", () => {
  it("remembers a ruling and recalls it by link key with provenance", async () => {
    const m = new HMEM({ dir: tempDir("hmem-") });
    const key = "PK260901003>DC-EAST";
    const id = await rememberRuling(m, { linkKey: key, ruling: "unproven", reason: "no receiving row for the BOL", runId: "run-7" });
    const rulings = await recallRulings(m, key);
    expect(rulings).toHaveLength(1);
    expect(rulings[0]).toMatchObject({ memoryId: id, ruling: "unproven", runId: "run-7", contested: false });
    expect(m.ledger.get(rulings[0].ledgerRef)?.action).toBe("create");
    expect(await recallRulings(m, "PK260901004>DC-EAST")).toEqual([]);
  });

  it("an opposite ruling on the same link is a conflict, both rulings stay on record", async () => {
    const m = new HMEM({ dir: tempDir("hmem-") });
    const key = "GR12-26244-F3>PK260901003";
    const a = await rememberRuling(m, { linkKey: key, ruling: "proven", reason: "quantity balances", runId: "run-1" });
    const b = await rememberRuling(m, { linkKey: key, ruling: "rejected", reason: "date order violated", runId: "run-2" });
    const conflicts = m.conflicts.forMemory(a);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toMatch(/same subject/);
    const rulings = await recallRulings(m, key);
    expect(rulings.map((r) => r.memoryId).sort()).toEqual([a, b].sort());
  });
});
