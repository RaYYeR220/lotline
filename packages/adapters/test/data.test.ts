import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import { TraceLog } from "@lotline/core";
import { DataTimeout, DuckDbSample, ZetarisClient, toRows } from "../src/data/index.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "data-"));
const trace = () => new TraceLog("t", { dir: tmp(), stdout: false });

async function sampleDb(): Promise<string> {
  const file = path.join(tmp(), "w.duckdb");
  const db = await DuckDBInstance.create(file);
  const conn = await db.connect();
  await conn.run("CREATE SCHEMA packer");
  await conn.run("CREATE TABLE packer.shipments (ship_id VARCHAR, output_lot VARCHAR, qty_cases INTEGER)");
  await conn.run("INSERT INTO packer.shipments VALUES ('S1', 'PK251014007', 40), ('S2', 'PK251014008', 12)");
  conn.closeSync();
  db.closeSync();
  return file;
}

describe("DuckDbSample", () => {
  it("runs the same two-part table SQL and traces it as a data-layer query", async () => {
    const t = trace();
    const data = new DuckDbSample(await sampleDb(), t);
    const res = await data.query("SELECT ship_id, qty_cases FROM packer.shipments WHERE output_lot = 'PK251014007';", { agent: "TracerAgent", purpose: "forward trace" });
    expect(res.rows).toEqual([{ ship_id: "S1", qty_cases: "40" }]);
    expect(res.backend).toBe("duckdb-sample");
    const ev = t.events()[0];
    expect(ev.agent_name).toBe("TracerAgent");
    expect(ev.action).toBe("zetaris.query");
    expect(ev.detail).toMatchObject({ backend: "duckdb-sample", rows: 1 });
    expect(await data.listTables({ agent: "SourceMapperAgent", purpose: "catalog" })).toEqual([{ source: "packer", table: "shipments" }]);
    expect((await data.describe("packer.shipments", { agent: "SourceMapperAgent", purpose: "schema" })).map((c) => c.name)).toEqual(["ship_id", "output_lot", "qty_cases"]);
    await data.close();
  });
});

describe("ZetarisClient", () => {
  const cfg = { baseUrl: "http://zetaris.test/api/v1.0", token: "k", orgId: "1" };

  it("posts one statement without a trailing semicolon and maps array rows to columns", async () => {
    const sent: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ columns: ["lot", "qty"], data: [["PK1", 40]] }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = trace();
    const z = new ZetarisClient({ ...cfg, fetchImpl }, t);
    const res = await z.query("SELECT lot, qty FROM packer.shipments;", { agent: "TracerAgent", purpose: "p" });
    expect(sent[0].url).toBe("http://zetaris.test/api/v1.0/sql-editor/sqls/run");
    expect(sent[0].body.sql).toBe("SELECT lot, qty FROM packer.shipments");
    expect(sent[0].headers["x-org-id"]).toBe("1");
    expect(sent[0].body.queryId).toBe(sent[0].headers["x-request-id"]);
    expect(res.rows).toEqual([{ lot: "PK1", qty: "40" }]);
    expect(t.events()[0].detail).toMatchObject({ backend: "zetaris", query_id: res.queryId });
  });

  it("retries a 5xx once", async () => {
    let n = 0;
    const fetchImpl = (async () => (++n === 1 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ data: [{ one: 1 }] }), { status: 200 }))) as unknown as typeof fetch;
    const z = new ZetarisClient({ ...cfg, fetchImpl }, trace());
    const res = await z.query("SELECT 1 AS one", { agent: "A", purpose: "p" });
    expect(n).toBe(2);
    expect(res.rows).toEqual([{ one: "1" }]);
  });

  it("turns a slow query into DataTimeout and logs the failure", async () => {
    const fetchImpl = ((_: string, init: any) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    const t = trace();
    const z = new ZetarisClient({ ...cfg, fetchImpl }, t);
    await expect(z.query("SELECT 1", { agent: "A", purpose: "p", timeoutMs: 50 })).rejects.toBeInstanceOf(DataTimeout);
    expect(t.events().at(-1)?.status).toBe("error");
  });

  it("accepts object rows too", () => {
    expect(toRows({ data: [{ a: 1, b: null }] })).toEqual({ columns: ["a", "b"], rows: [{ a: "1", b: null }] });
  });
});
