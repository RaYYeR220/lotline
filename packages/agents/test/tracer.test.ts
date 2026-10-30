import { afterEach, describe, expect, it } from "vitest";
import type { QueryResult, Row } from "@lotline/adapters";
import type { AgentContext } from "../src/context.ts";
import type { SourceMap } from "../src/mapper.ts";
import { traceForward } from "../src/tracer.ts";

const map = {
  "packer.repacks": { table: "packer.repacks", cte: "transformation", pk: "repack_id", lot: "output_lot", date: "packed_at", qty: "qty_in", location: null },
  "wms.lpn": { table: "wms.lpn", cte: "reference", pk: "internal_lpn", lot: "vendor_lot", date: null, qty: null, location: null },
  "wms.receiving": { table: "wms.receiving", cte: "receiving", pk: "rcv_id", lot: "vendor_lot", date: "received_at", qty: "qty_cases", location: "vendor_id" },
  "wms.store_shipments": { table: "wms.store_shipments", cte: "shipping", pk: "order_line_id", lot: "internal_lpn", date: "ship_date", qty: "qty_cases", location: "location_id" },
  "retail.receipts": { table: "retail.receipts", cte: "receiving", pk: "receipt_id", lot: "supplier_ref_lot", date: "received_at", qty: "qty_cases", location: "store_id" },
} as SourceMap;

const result = (sql: string, rows: Row[]): QueryResult => ({ queryId: "q", backend: "zetaris", columns: [], rows, elapsedMs: 0, sql });

function ctxFor(answer: (sql: string) => Row[]): AgentContext {
  return {
    data: {
      backend: "zetaris",
      query: async (sql: string) => result(sql, answer(sql)),
      listTables: async () => [],
      describe: async () => [],
      close: async () => {},
    },
    trace: { emit() {} },
  } as unknown as AgentContext;
}

/** One direct lot, one pallet, one store delivery, one corroborating receipt. */
async function traceStoreReceipts() {
  const sqls: string[] = [];
  const graph = await traceForward(ctxFor((sql) => {
    sqls.push(sql);
    if (sql.includes("FROM wms.lpn")) return [{ internal_lpn: "L1", vendor_lot: "AR260818Q3" }];
    if (sql.includes("FROM wms.store_shipments")) return [{ order_line_id: "O1", internal_lpn: "L1", location_id: "ST26", ship_date: "2026-08-21", qty_cases: "3" }];
    if (sql.includes("store_id IN")) return [{ receipt_id: "LKV-486343", store_id: "ST26", store_name: "Lakeview Markets #503 Carson City", supplier_ref_lot: "LKV:AR260818Q3", received_at: "2026-08-21 08:25:00", qty_cases: "3" }];
    return [];
  }), ["AR260818Q3"], "romaine", map);
  const receiptSql = sqls.find((s) => s.includes("store_id IN"));
  const receipt = graph.links.find((l) => l.kind === "shipped-to")?.evidence.find((e) => e.rowKey === "LKV-486343");
  return { receiptSql, receipt };
}

describe("store receipts source", () => {
  const previous = process.env.LOTLINE_STORE_RECEIPTS;
  afterEach(() => {
    if (previous === undefined) delete process.env.LOTLINE_STORE_RECEIPTS;
    else process.env.LOTLINE_STORE_RECEIPTS = previous;
  });

  it("reads retail.receipts when LOTLINE_STORE_RECEIPTS is unset", async () => {
    delete process.env.LOTLINE_STORE_RECEIPTS;
    const { receiptSql, receipt } = await traceStoreReceipts();
    expect(receiptSql).toContain("FROM retail.receipts WHERE");
    expect(receipt).toMatchObject({ source: "retail", table: "receipts" });
  });

  it("reads the table named by LOTLINE_STORE_RECEIPTS", async () => {
    process.env.LOTLINE_STORE_RECEIPTS = "lightning.metastore.lotline.receiving.store_receipts";
    const { receiptSql, receipt } = await traceStoreReceipts();
    expect(receiptSql).toContain("FROM lightning.metastore.lotline.receiving.store_receipts WHERE");
    expect(receipt).toMatchObject({ source: "lightning.metastore.lotline.receiving", table: "store_receipts" });
  });
});
