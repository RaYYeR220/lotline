import { describe, expect, it } from "vitest";
import type { DataLayer, QueryResult } from "@lotline/adapters";
import { NAMESPACE, ToolError, assertReadOnly, zetarisTools } from "../src/tools.ts";

function fakeZetaris(fail: (sql: string) => boolean = () => false) {
  const sent: string[] = [];
  const result = (sql: string, rows: Record<string, string | null>[] = []): QueryResult => ({ queryId: `q${sent.length}`, backend: "zetaris", columns: Object.keys(rows[0] ?? {}), rows, elapsedMs: 1, sql });
  const run = async (sql: string) => {
    sent.push(sql);
    if (fail(sql)) throw new Error(`refused: ${sql.slice(0, 30)}`);
    if (sql.startsWith("RUN DQ")) return result(sql, [{ name: "r", total_record: "10", valid_record: "8", invalid_record: "2" }]);
    if (sql.startsWith("SELECT COUNT")) return result(sql, [{ n: "3314" }]);
    return result(sql, [{ a: "1" }]);
  };
  const z: DataLayer = {
    backend: "zetaris",
    query: run,
    writeBack: run,
    listTables: async () => [{ source: "retail", table: "receipts" }, { source: "wms", table: "lpn" }],
    describe: async () => [{ name: "Receipt No", type: "string" }],
    close: async () => {},
  };
  return { z, sent };
}

describe("run_sql is read-only", () => {
  it("accepts reads across sources", () => {
    expect(assertReadOnly("SELECT s.store_id FROM wms.store_shipments s JOIN retail.receipts r ON s.location_id = r.store_id;")).not.toMatch(/;$/);
    expect(() => assertReadOnly("SHOW NAMESPACES OR TABLES IN lightning.metastore.lotline")).not.toThrow();
    expect(() => assertReadOnly("SELECT created_at, 'drop table x' AS note FROM t")).not.toThrow();
  });
  it("refuses writes and stacked statements", () => {
    expect(() => assertReadOnly("DROP LIGHTNING DATABASE retail")).toThrow(ToolError);
    expect(() => assertReadOnly("SELECT 1; DROP DATASOURCE packer")).toThrow(/one statement/);
    expect(() => assertReadOnly("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x")).toThrow(/insert/i);
  });
});

describe("zetaris tools", () => {
  it("lists the catalog grouped by partner system", async () => {
    const { z } = fakeZetaris();
    const out = await zetarisTools(z).list_sources();
    expect(out.sources).toEqual({ retail: ["receipts"], wms: ["lpn"] });
  });

  it("registers a partner CSV inside the file store only", async () => {
    const { z, sent } = fakeZetaris();
    const t = zetarisTools(z);
    const out = await t.register_file({ database: "retail", table: "lakeview_receipts", file: "lakeview/receipts.csv", description: "Lakeview nightly receipts (CSV)" });
    expect(out.registered).toBe("retail.lakeview_receipts");
    expect(sent[0]).toMatch(/^CREATE LIGHTNING FILESTORE TABLE lakeview_receipts FROM retail FORMAT CSV OPTIONS \(path ".*\/lakeview\/receipts\.csv"/);
    expect(sent[0]).toContain('description "lakeview_nightly_receipts_csv"');
    await expect(t.register_file({ database: "retail", table: "x", file: "../../etc/passwd.csv", description: "" })).rejects.toThrow(ToolError);
    await expect(t.register_file({ database: "Retail; DROP", table: "x", file: "a.csv", description: "" })).rejects.toThrow(/database/);
  });

  it("publishes a semantic-layer table with a non-null key and cast columns", async () => {
    const { z, sent } = fakeZetaris();
    const out = await zetarisTools(z).publish_semantic_table({
      usl: "receiving", table: "store_receipts", key: "receipt_id",
      columns: [{ name: "receipt_id", type: "string" }, { name: "qty_cases", type: "int" }],
      select: "SELECT receipt_id, qty_cases FROM retail.receipts",
    });
    expect(out).toMatchObject({ published: `${NAMESPACE}.receiving.store_receipts`, rows: 3314 });
    const compile = sent.find((s) => s.startsWith("COMPILE USL"))!;
    expect(compile).toContain("receipt_id varchar(200) NOT NULL PRIMARY KEY");
    const activate = sent.find((s) => s.startsWith("ACTIVATE USL TABLE"))!;
    expect(activate).toContain("COALESCE(CAST(s.receipt_id AS STRING), '') AS receipt_id");
    expect(activate).toContain("CAST(s.qty_cases AS INT) AS qty_cases");
  });

  it("refuses a semantic table whose SELECT writes", async () => {
    const { z } = fakeZetaris();
    await expect(zetarisTools(z).publish_semantic_table({ usl: "receiving", table: "t", key: "k", columns: [{ name: "k", type: "string" }], select: "DELETE FROM retail.receipts" })).rejects.toThrow(ToolError);
  });

  it("runs a quality rule and reports failing rows", async () => {
    const { z } = fakeZetaris((sql) => sql.startsWith("REGISTER DQ"));
    const out = await zetarisTools(z).quality_check({ rule: "has_lot", table: `${NAMESPACE}.receiving.store_receipts`, expression: "supplier_ref_lot IS NOT NULL" });
    expect(out).toMatchObject({ total: 10, valid: 8, invalid: 2 });
  });

  it("explains a rule that could not be registered", async () => {
    const { z } = fakeZetaris((sql) => sql.startsWith("REGISTER DQ") || sql.startsWith("RUN DQ"));
    await expect(zetarisTools(z).quality_check({ rule: "has_lot", table: `${NAMESPACE}.receiving.store_receipts`, expression: "x IS NOT NULL" })).rejects.toThrow(/could not be registered/);
  });
});
