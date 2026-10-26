import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorldModel, decide, entityIdFromName, nameSimilarity, normalizeName } from "../src/index.ts";

const src = (at: string) => ({ kind: "manual", at });
const tmpLog = () => path.join(mkdtempSync(path.join(tmpdir(), "wm-")), "world.jsonl");

describe("stable ids and resolution bands", () => {
  it("normalizes diacritics, NBSP and zero-width characters without over-normalizing", () => {
    expect(normalizeName("  José García​ ")).toBe("jose garcia");
    expect(entityIdFromName("person", "José García")).toBe(entityIdFromName("person", "jose  garcia"));
    expect(entityIdFromName("org", "Acme Corp")).not.toBe(entityIdFromName("org", "Acme Corporation"));
    expect(entityIdFromName("person", "x")).toMatch(/^ent_[0-9a-f]{16}$/);
  });

  it("bands similarity at the boundaries", () => {
    expect(decide(0.85)).toBe("auto-merge");
    expect(decide(0.849)).toBe("review");
    expect(decide(0.82)).toBe("review");
    expect(decide(0.819)).toBe("new");
    expect(nameSimilarity("Jerome Powell", "jerome powell")).toBe(1);
  });
});

describe("WorldModel writes", () => {
  it("rejects writes without provenance or with an unreadable timestamp", async () => {
    const world = new WorldModel();
    await expect(world.upsertEntity({ type: "lot", id: "lot:A", source: undefined as never })).rejects.toThrow(/provenance/);
    await expect(world.upsertEntity({ type: "lot", id: "lot:A", source: { kind: "manual" } as never })).rejects.toThrow(/provenance/);
    await expect(world.upsertEntity({ type: "lot", id: "lot:A", source: src("not a date") })).rejects.toThrow(/timestamp/);
    expect(world.events()).toHaveLength(0);
  });

  it("treats a repeated identical write as a no-op", async () => {
    const world = new WorldModel();
    await world.upsertEntity({ type: "location", id: "loc:S1", name: "Store 1", source: src("2026-09-01") });
    await world.upsertEntity({ type: "location", id: "loc:S1", name: "Store 1", source: src("2026-09-02") });
    await world.relate({ from: "lot:A", type: "shipped-to", to: "loc:S1", cardinality: "many", source: src("2026-09-03") });
    await world.relate({ from: "lot:A", type: "shipped-to", to: "loc:S1", cardinality: "many", source: src("2026-09-03") });
    expect(world.events().map((e) => e.kind)).toEqual(["entity.upserted", "relation.asserted"]);
    // relate() materializes unknown endpoints so no edge ever dangles
    expect(world.view("graph").entity("lot:A")).toMatchObject({ type: "lot", state: "emerging" });
  });

  it("updates edge attributes in place when the same edge is re-asserted with new content", async () => {
    const world = new WorldModel();
    const edge = { from: "lot:A", type: "shipped-to", to: "loc:S1", source: src("2026-09-03") };
    await world.relate({ ...edge, cardinality: "many", attrs: { status: "proposed", quantity: 40 } });
    const updated = await world.relate({ ...edge, attrs: { status: "proven" } });
    expect(updated.attrs).toEqual({ status: "proven", quantity: 40 });
    // the re-assertion did not name a cardinality, so the edge keeps the one it was created with
    expect(updated.cardinality).toBe("many");
    expect(world.view("graph").edges("lot:A")).toHaveLength(1);
  });

  it("auto-merges near-identical name-keyed entities and queues the review band", async () => {
    const world = new WorldModel();
    await world.upsertEntity({ type: "firm", name: "Valley Fresh Farms", source: src("2026-09-01") });
    const merged = await world.upsertEntity({ type: "firm", name: "Valley Fresh Farm", source: src("2026-09-02") });
    expect(merged.id).toBe(entityIdFromName("firm", "Valley Fresh Farms"));
    expect(merged.aliases).toEqual(["Valley Fresh Farms", "Valley Fresh Farm"]);
    // externally keyed entities are never merged by name, however close the names are
    await world.upsertEntity({ type: "firm", id: "firm:fda:1001", name: "Valley Fresh Farmz", source: src("2026-09-03") });
    expect(world.view("graph").entity("firm:fda:1001")?.id).toBe("firm:fda:1001");
    expect(world.mergeQueue()).toHaveLength(0);

    // 2 edits in 12 characters = 0.833: inside the review band, so both entities exist and a proposal waits
    const review = new WorldModel();
    const left = await review.upsertEntity({ type: "firm", name: "Green Valley", source: src("2026-09-01") });
    const right = await review.upsertEntity({ type: "firm", name: "Grean Vallex", source: src("2026-09-02") });
    expect(left.id).not.toBe(right.id);
    expect(review.mergeQueue()).toMatchObject([{ leftId: right.id, rightId: left.id }]);
  });

  it("delivers appended events to subscribers in order; a failing subscriber does not fail the write", async () => {
    const world = new WorldModel();
    const seen: number[] = [];
    world.subscribe((e) => seen.push(e.seq));
    world.subscribe(() => {
      throw new Error("broken listener");
    });
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await world.upsertEntity({ type: "lot", id: "lot:A", source: src("2026-09-01") });
    await world.relate({ from: "lot:A", type: "shipped-to", to: "loc:S1", source: src("2026-09-02") });
    expect(seen).toEqual([1, 2]);
    expect(report).toHaveBeenCalledTimes(2);
    report.mockRestore();
  });

  it("writes one audit entry per appended event, in strictly increasing order", async () => {
    const world = new WorldModel({ clock: () => new Date("2026-10-01T00:00:00Z") });
    await world.upsertEntity({ type: "lot", id: "lot:A", source: { kind: "zetaris", at: "2026-09-01", by: "TracerAgent" } });
    await world.relate({ from: "lot:A", type: "shipped-to", to: "loc:S1", source: src("2026-09-02") });
    const audit = world.audit();
    expect(audit.map((a) => a.seq)).toEqual([1, 2]);
    expect(audit[0]).toMatchObject({ kind: "entity.upserted", actor: "TracerAgent", recordedAt: "2026-10-01T00:00:00.000Z" });
    expect(audit[1].summary).toBe("lot:A -[shipped-to]-> loc:S1");
  });
});

describe("bitemporal edges", () => {
  it("closes a cardinality-one edge when a successor arrives, even out of order", async () => {
    const world = new WorldModel();
    // the newer custody record is written first; the older one must still end where the newer begins
    await world.relate({ from: "pallet:P1", type: "held-by", to: "loc:DC2", validFrom: "2026-09-05", source: src("2026-09-05") });
    await world.relate({ from: "pallet:P1", type: "held-by", to: "loc:DC1", validFrom: "2026-09-01", source: src("2026-09-01") });
    const graph = world.view("graph");
    expect(graph.neighborsOf("pallet:P1", { via: "held-by" }).map((e) => e.id)).toEqual(["loc:DC2"]);
    expect(graph.neighborsOf("pallet:P1", { via: "held-by", at: "2026-09-03" }).map((e) => e.id)).toEqual(["loc:DC1"]);
    expect(graph.neighborsOf("pallet:P1", { via: "held-by", at: "2026-08-31" })).toEqual([]);
    const dc1 = graph.edges("pallet:P1", { via: "held-by", includeClosed: true }).find((e) => e.to === "loc:DC1");
    expect(dc1?.validTo).toBe("2026-09-05T00:00:00.000Z");
  });

  it("keeps every cardinality-many edge open", async () => {
    const world = new WorldModel({ cardinality: { "shipped-to": "many" } });
    await world.relate({ from: "lot:A", type: "shipped-to", to: "loc:S1", validFrom: "2026-09-03", source: src("2026-09-03") });
    await world.relate({ from: "lot:A", type: "shipped-to", to: "loc:S2", validFrom: "2026-09-05", source: src("2026-09-05") });
    const edges = world.view("graph").edges("lot:A", { via: "shipped-to" });
    expect(edges.map((e) => e.to)).toEqual(["loc:S1", "loc:S2"]);
    expect(edges.every((e) => e.validTo === undefined)).toBe(true);
  });

  it("treats a date-only point-in-time query as the end of that day", async () => {
    const world = new WorldModel();
    await world.relate({ from: "lot:A", type: "shipped-to", to: "loc:S1", cardinality: "many", validFrom: "2026-09-03T15:00:00Z", source: src("2026-09-03T15:00:00Z") });
    const graph = world.view("graph");
    expect(graph.neighborsOf("lot:A", { at: "2026-09-02" })).toEqual([]);
    expect(graph.neighborsOf("lot:A", { at: "2026-09-03" }).map((e) => e.id)).toEqual(["loc:S1"]);
  });
});

describe("observation ingest", () => {
  const batch = [
    { externalId: "n1", title: "Romaine recall", at: "2026-09-10T10:00:00Z", source: { kind: "api" }, entities: [{ type: "firm", name: "Valley Fresh" }] },
    { externalId: "n2", title: "Recall expanded", at: "2026-09-11T10:00:00Z", source: { kind: "api" }, entities: [{ type: "firm", name: "Valley Fresh" }] },
  ];

  it("appends zero events when the same batch is ingested twice", async () => {
    const world = new WorldModel();
    const first = await world.ingest(batch);
    const shape = world.stateShapeCanonical();
    const events = world.events().length;
    const second = await world.ingest(batch);
    expect(first).toMatchObject({ processed: 2, skipped: 0, changed: true });
    expect(second).toMatchObject({ processed: 0, skipped: 2, appended: 0, changed: false });
    expect(world.events()).toHaveLength(events);
    expect(world.stateShapeCanonical()).toBe(shape);
  });

  it("validates the whole batch before appending anything", async () => {
    const world = new WorldModel();
    await expect(world.ingest([batch[0], { ...batch[1], at: "garbage" }])).rejects.toThrow();
    expect(world.events()).toHaveLength(0);
  });
});

describe("file storage", () => {
  it("rebuilds the same state from the JSONL event log", async () => {
    const file = tmpLog();
    const world = new WorldModel({ storage: "file", path: file });
    await world.upsertEntity({ type: "location", id: "loc:S1", name: "Store 1", source: src("2026-09-01") });
    await world.relate({ from: "pallet:P1", type: "held-by", to: "loc:DC1", validFrom: "2026-09-01", source: src("2026-09-01") });
    await world.relate({ from: "pallet:P1", type: "held-by", to: "loc:DC2", validFrom: "2026-09-05", source: src("2026-09-05") });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(3);

    const reopened = new WorldModel({ storage: "file", path: file });
    expect(reopened.stateShapeCanonical()).toBe(world.stateShapeCanonical());
    expect(reopened.audit()).toEqual(world.audit());
    await reopened.upsertEntity({ type: "location", id: "loc:S2", source: src("2026-09-06") });
    expect(reopened.audit().map((a) => a.seq)).toEqual([1, 2, 3, 4]);
  });

  it("drops a torn final line left by an interrupted append", async () => {
    const file = tmpLog();
    const world = new WorldModel({ storage: "file", path: file });
    await world.upsertEntity({ type: "location", id: "loc:S1", source: src("2026-09-01") });
    appendFileSync(file, '{"v":1,"seq":2,"kind":"entity.ups');
    const reopened = new WorldModel({ storage: "file", path: file });
    expect(reopened.stateShapeCanonical()).toBe(world.stateShapeCanonical());
    await reopened.upsertEntity({ type: "location", id: "loc:S2", source: src("2026-09-02") });
    expect(new WorldModel({ storage: "file", path: file }).events()).toHaveLength(2);
  });

  it("refuses to load a log that is corrupt before its last line", async () => {
    const file = tmpLog();
    const world = new WorldModel({ storage: "file", path: file });
    await world.upsertEntity({ type: "location", id: "loc:S1", source: src("2026-09-01") });
    appendFileSync(file, "not json\n");
    await world.upsertEntity({ type: "location", id: "loc:S2", source: src("2026-09-02") });
    expect(() => new WorldModel({ storage: "file", path: file })).toThrow(/corrupt/);
  });
});
