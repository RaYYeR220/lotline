import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Evidence, LinkKind, LinkStatus, TraceLink } from "@lotline/core";
import { describe, expect, it } from "vitest";
import { WorldModel, explainPath, ingestLinks, linkToRelation, reachableFrom } from "../src/index.ts";

const evidence = (rowKey: string, queryId = `q-${rowKey}`): Evidence => ({
  source: "packer", table: "packer.shipments", rowKey, queryId,
  sql: "SELECT * FROM packer.shipments WHERE output_lot = 'C'", fields: { row: rowKey },
});

const link = (kind: LinkKind, from: string, to: string, at: string, status: LinkStatus = "proven"): TraceLink => ({
  id: `${kind}:${from}:${to}:${at}`, kind, from, to, at, evidence: [evidence(`${from}>${to}`)], status, confidence: 0.9, notes: [],
});

// Lots A and B are repacked (commingled) into C; C ships to two stores. D is an unrelated lot.
const network: TraceLink[] = [
  link("derived-from", "lot:C", "lot:A", "2026-09-02"),
  link("derived-from", "lot:C", "lot:B", "2026-09-02"),
  link("shipped-to", "lot:C", "loc:S1", "2026-09-03"),
  link("shipped-to", "lot:C", "loc:S2", "2026-09-04"),
  link("shipped-to", "lot:D", "loc:S3", "2026-09-03"),
];

async function world(links: TraceLink[] = network): Promise<WorldModel> {
  const w = new WorldModel({ namespace: "trace" });
  await ingestLinks(w, links);
  return w;
}

describe("linkToRelation", () => {
  it("maps a trace link to a non-superseding edge with Zetaris provenance", () => {
    const rel = linkToRelation({ ...link("shipped-to", "lot:C", "loc:S1", "2026-09-03"), quantity: 40 });
    expect(rel).toMatchObject({
      from: "lot:C", type: "shipped-to", to: "loc:S1", validFrom: "2026-09-03", cardinality: "many",
      source: { kind: "zetaris", at: "2026-09-03", ref: "q-lot:C>loc:S1", linkId: "shipped-to:lot:C:loc:S1:2026-09-03" },
      attrs: { status: "proven", confidence: 0.9, quantity: 40, evidence: ["packer:packer.shipments#lot:C>loc:S1"] },
    });
  });
});

describe("reachableFrom", () => {
  it("commingled lot propagates: an implicated input reaches the output lot and its stores", async () => {
    const w = await world();
    expect(reachableFrom(w, "lot:A")).toEqual(["loc:S1", "loc:S2", "lot:C"]);
    // either input of the repack is enough; the sibling input is not itself affected
    expect(reachableFrom(w, "lot:B")).toEqual(["loc:S1", "loc:S2", "lot:C"]);
    expect(reachableFrom(w, "lot:A")).not.toContain("lot:B");
    expect(reachableFrom(w, "lot:D")).toEqual(["loc:S3"]);
  });

  it("answers point-in-time: a lot shipped on day 3 is not reachable on day 2", async () => {
    const w = await world();
    expect(reachableFrom(w, "lot:C", { at: "2026-09-02" })).toEqual([]);
    expect(reachableFrom(w, "lot:C", { at: "2026-09-03" })).toEqual(["loc:S1"]);
    expect(reachableFrom(w, "lot:C", { at: "2026-09-04" })).toEqual(["loc:S1", "loc:S2"]);
  });

  it("keeps partial shipments to several stores open at once", async () => {
    const w = await world();
    const edges = w.view("graph").edges("lot:C", { via: "shipped-to", direction: "out" });
    expect(edges.map((e) => e.to)).toEqual(["loc:S1", "loc:S2"]);
    expect(edges.every((e) => e.validTo === undefined)).toBe(true);
  });

  it("never propagates through a rejected link and can be limited to proven links", async () => {
    const w = await world([
      ...network,
      link("shipped-to", "lot:C", "loc:S4", "2026-09-05", "rejected"),
      link("shipped-to", "lot:C", "loc:S5", "2026-09-05", "contested"),
    ]);
    expect(reachableFrom(w, "lot:A")).toEqual(["loc:S1", "loc:S2", "loc:S5", "lot:C"]);
    expect(reachableFrom(w, "lot:A", { statuses: ["proven"] })).toEqual(["loc:S1", "loc:S2", "lot:C"]);
  });

  it("follows received-as and harvested-as downstream and respects a via filter", async () => {
    const w = await world([
      link("harvested-as", "harvest:GR1-26245-F3", "lot:A", "2026-09-01"),
      ...network,
      link("received-as", "lot:C", "lpn:L00000001", "2026-09-03"),
      link("shipped-to", "lpn:L00000001", "loc:S9", "2026-09-04"),
    ]);
    expect(reachableFrom(w, "harvest:GR1-26245-F3")).toEqual(["loc:S1", "loc:S2", "loc:S9", "lot:A", "lot:C", "lpn:L00000001"]);
    expect(reachableFrom(w, "lot:A", { via: ["derived-from"] })).toEqual(["lot:C"]);
  });

  it("returns nothing for a lot the network never handled", async () => {
    const w = await world();
    expect(reachableFrom(w, "lot:NEVER-SEEN")).toEqual([]);
  });
});

describe("explainPath", () => {
  it("returns the chain of edges with their provenance", async () => {
    const w = await world();
    const steps = explainPath(w, "lot:A", "loc:S2");
    expect(steps?.map((s) => [s.from, s.via, s.direction, s.to])).toEqual([
      ["lot:A", "derived-from", "reverse", "lot:C"],
      ["lot:C", "shipped-to", "forward", "loc:S2"],
    ]);
    expect(steps?.[1].edge.source).toMatchObject({ kind: "zetaris", ref: "q-lot:C>loc:S2" });
    expect(steps?.[1].edge.attrs.evidence).toEqual(["packer:packer.shipments#lot:C>loc:S2"]);
    expect(explainPath(w, "lot:A", "lot:A")).toEqual([]);
    expect(explainPath(w, "lot:D", "loc:S1")).toBeNull();
  });
});

describe("ingestLinks", () => {
  it("rerun idempotent: the same links twice report changed=false and an identical shape", async () => {
    const w = new WorldModel();
    const first = await ingestLinks(w, network);
    const shape = w.stateShapeCanonical();
    // a rerun re-proves the same links through fresh queries: new query ids are corroboration, not change
    const rerun = network.map((l) => ({ ...l, evidence: l.evidence.map((e) => ({ ...e, queryId: `rerun-${e.queryId}` })) }));
    const second = await ingestLinks(w, rerun);
    expect(first.changed).toBe(true);
    expect(second).toMatchObject({ changed: false, appended: 0, skipped: network.length });
    expect(w.stateShapeCanonical()).toBe(shape);

    const verdict = await ingestLinks(w, [{ ...network[2], status: "rejected" }]);
    expect(verdict).toMatchObject({ changed: true, appended: 1 });
    expect(reachableFrom(w, "lot:A")).not.toContain("loc:S1");
  });

  it("persists the trace graph across runs with file storage", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "wm-trace-")), "trace.jsonl");
    const first = new WorldModel({ storage: "file", path: file });
    await ingestLinks(first, network);
    const second = new WorldModel({ storage: "file", path: file });
    expect(second.stateShapeCanonical()).toBe(first.stateShapeCanonical());
    expect(reachableFrom(second, "lot:A")).toEqual(["loc:S1", "loc:S2", "lot:C"]);
    expect((await ingestLinks(second, network)).changed).toBe(false);
  });
});
