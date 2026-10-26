import { randomUUID } from "node:crypto";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { TraceLog } from "@lotline/core";
import { short } from "../model/nightshift.ts";
import { DataError, DataTimeout, type DataLayer, type QueryContext, type QueryResult, type Row } from "./types.ts";

const cell = (v: unknown): string | null => (v == null ? null : typeof v === "object" ? String(v) : String(v));

/**
 * Sample mode data layer: the same partner tables, the same SQL, served from a bundled DuckDB file
 * instead of Zetaris. Agents cannot tell the difference except through the trace's `backend` field.
 */
export class DuckDbSample implements DataLayer {
  readonly backend = "duckdb-sample" as const;
  private conn?: Promise<DuckDBConnection>;

  constructor(private readonly dbPath: string, private readonly trace: TraceLog) {}

  private connection(): Promise<DuckDBConnection> {
    this.conn ??= DuckDBInstance.create(this.dbPath, { access_mode: "READ_ONLY" }).then((db) => db.connect());
    return this.conn;
  }

  async query(rawSql: string, ctx: QueryContext): Promise<QueryResult> {
    const sql = rawSql.trim().replace(/;+\s*$/, "");
    const queryId = randomUUID();
    const started = Date.now();
    const timeoutMs = ctx.timeoutMs ?? 60_000;
    try {
      const conn = await this.connection();
      const reader = await Promise.race([
        conn.runAndReadAll(sql),
        new Promise<never>((_, reject) => setTimeout(() => reject(new DataTimeout(sql, timeoutMs)), timeoutMs)),
      ]);
      const columns = reader.columnNames();
      const rows: Row[] = reader.getRows().map((r) => Object.fromEntries(columns.map((c, i) => [c, cell(r[i])])));
      const result: QueryResult = { queryId, backend: "duckdb-sample", columns, rows, elapsedMs: Date.now() - started, sql };
      this.trace.emit({
        agent_name: ctx.agent, action: "zetaris.query", input_summary: short(ctx.purpose), output_summary: `${rows.length} rows`,
        target_agent: ctx.targetAgent ?? null, status: "success",
        detail: { sql, query_id: queryId, backend: "duckdb-sample", rows: rows.length, ms: result.elapsedMs },
      });
      return result;
    } catch (err) {
      this.trace.emit({
        agent_name: ctx.agent, action: "zetaris.query", input_summary: short(ctx.purpose), output_summary: `failed: ${short((err as Error).message)}`,
        target_agent: ctx.targetAgent ?? null, status: "error", detail: { sql, backend: "duckdb-sample" },
      });
      if (err instanceof DataTimeout) throw err;
      throw new DataError((err as Error).message);
    }
  }

  async listTables(ctx: QueryContext): Promise<{ source: string; table: string }[]> {
    const res = await this.query(
      "SELECT table_schema AS source, table_name AS table_name FROM information_schema.tables WHERE table_schema NOT IN ('main','information_schema','pg_catalog') ORDER BY 1, 2",
      ctx,
    );
    return res.rows.map((r) => ({ source: String(r.source), table: String(r.table_name) }));
  }

  async describe(table: string, ctx: QueryContext): Promise<{ name: string; type: string }[]> {
    const [schema, name] = table.split(".");
    const res = await this.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${name}' ORDER BY ordinal_position`,
      ctx,
    );
    return res.rows.map((r) => ({ name: String(r.column_name), type: String(r.data_type) }));
  }

  async close(): Promise<void> {
    if (this.conn) (await this.conn).closeSync();
  }
}
