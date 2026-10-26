import { describe, expect, it } from "vitest";
import type { TraceLink } from "@lotline/core";
import { FDA_COLUMNS, buildSpreadsheet } from "../src/fda.ts";

const ev = (table: string, rowKey: string, fields: Record<string, string>) => ({ source: table.split(".")[0], table: table.split(".")[1], rowKey, queryId: `q-${rowKey}`, sql: "SELECT", fields });

const links: TraceLink[] = [
  {
    id: "L1", kind: "received-as", from: "lot:packer:PK251014007", to: "lpn:wms:L00001234", at: "2026-10-15", quantity: 38, status: "proven", confidence: 0.95, notes: [],
    evidence: [
      ev("packer.shipments", "S1", { output_lot: "PK251014007", qty_cases: "40", ship_date: "2026-10-14", customer_id: "NGP", bol_no: "88213" }),
      ev("wms.receiving", "R1", { vendor_lot: "PK-251014-7", qty_cases: "38", received_at: "2026-10-15", bol_no: "88213", vendor_id: "PKR" }),
    ],
  },
  {
    id: "L2", kind: "shipped-to", from: "lpn:wms:L00001234", to: "loc:S14", at: "2026-10-16", status: "unproven", confidence: 0.4, notes: ["panel split 1/1/1"],
    evidence: [ev("wms.store_shipments", "O1", { internal_lpn: "L00001234", location_id: "S14", ship_date: "2026-10-16", qty_cases: "6", route_id: "R9" })],
  },
];

describe("buildSpreadsheet", () => {
  it("emits the exact header order and one row per proven evidence record", () => {
    const { csv, rows } = buildSpreadsheet(links, "Chopped romaine");
    const lines = csv.split("\n");
    expect(lines[0]).toBe(FDA_COLUMNS.join(","));
    expect(rows).toBe(2);
    expect(lines[1]).toContain("shipping");
    expect(lines[2]).toContain("receiving");
    expect(lines[2]).toContain("88213");
  });

  it("keeps unproven links out of the FDA rows and lists them separately", () => {
    const { csv, unproven } = buildSpreadsheet(links, "Chopped romaine");
    expect(unproven.map((l) => l.id)).toEqual(["L2"]);
    const [main, extra] = csv.split("unproven_links");
    expect(main).not.toContain("L00001234,S14");
    expect(extra).toContain("panel split 1/1/1");
  });
});
