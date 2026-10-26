import { randomUUID } from "node:crypto";
import type { TraceLog } from "@lotline/core";
import { short } from "../model/nightshift.ts";
import { DataError, DataTimeout, type DataLayer, type QueryContext, type QueryResult, type Row } from "./types.ts";

interface ZetarisOptions {
  baseUrl: string;
  token: string;
  orgId: string;
  fetchImpl?: typeof fetch;
  limit?: number;
}

/** Normalise the REST payload: rows arrive either as objects or as arrays with a separate header. */
export function toRows(payload: any): { columns: string[]; rows: Row[] } {
  const data = payload?.data ?? payload?.rows ?? [];
  if (!Array.isArray(data) || data.length === 0) {
    const cols = payload?.columns ?? payload?.header ?? payload?.schema ?? [];
    return { columns: Array.isArray(cols) ? cols.map((c: any) => String(c?.name ?? c)) : [], rows: [] };
  }
  if (!Array.isArray(data[0])) {
    const columns = Object.keys(data[0]);
    return { columns, rows: data.map((r: any) => Object.fromEntries(columns.map((c) => [c, r[c] == null ? null : String(r[c])]))) };
  }
  const header = payload?.columns ?? payload?.header ?? payload?.schema;
  const columns: string[] = Array.isArray(header) ? header.map((c: any) => String(c?.name ?? c)) : data[0].map((_: unknown, i: number) => `c${i}`);
  return { columns, rows: data.map((r: any[]) => Object.fromEntries(columns.map((c, i) => [c, r[i] == null ? null : String(r[i])]))) };
}

/** Zetaris as the data layer: one Lightning SQL statement per call against the REST API. */
export class ZetarisClient implements DataLayer {
  readonly backend = "zetaris" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ZetarisOptions, private readonly trace: TraceLog) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async query(sql: string, ctx: QueryContext): Promise<QueryResult> {
    return this.run(sql, ctx, "zetaris.query");
  }

  async writeBack(sql: string, ctx: QueryContext): Promise<QueryResult> {
    return this.run(sql, ctx, "zetaris.write_back");
  }

  /** Registered datasources (JDBC) and Lightning databases (files, REST), with their tables. */
  async listTables(ctx: QueryContext): Promise<{ source: string; table: string }[]> {
    const out: { source: string; table: string }[] = [];
    const first = (row: Record<string, string | null>, keys: string[]) => keys.map((k) => row[k]).find((v) => v) ?? Object.values(row).find((v) => v) ?? null;
    const collect = async (listSql: string, tablesSql: (name: string) => string) => {
      const owners = await this.query(listSql, ctx).catch(() => null);
      for (const row of owners?.rows ?? []) {
        const owner = first(row, ["name", "datasource", "datasourceName", "database", "databaseName", "namespace"]);
        if (!owner) continue;
        const tables = await this.query(tablesSql(owner), ctx).catch(() => null);
        for (const t of tables?.rows ?? []) {
          const name = first(t, ["tableName", "table_name", "name", "table"]);
          if (name && name !== owner) out.push({ source: owner, table: String(name).split(".").at(-1)! });
        }
      }
    };
    await collect("SHOW DATASOURCES", (ds) => `SHOW DATASOURCE TABLES ${ds}`);
    await collect("SHOW LIGHTNING DATABASES", (db) => `SHOW LIGHTNING TABLES ${db}`);
    return out;
  }

  async describe(table: string, ctx: QueryContext): Promise<{ name: string; type: string }[]> {
    const res = await this.query(`DESCRIBE ${table}`, ctx);
    return res.rows.map((r) => ({ name: String(r.col_name ?? r.name ?? Object.values(r)[0]), type: String(r.data_type ?? r.type ?? Object.values(r)[1] ?? "") }));
  }

  async close(): Promise<void> {}

  private async run(rawSql: string, ctx: QueryContext, action: string): Promise<QueryResult> {
    const sql = rawSql.trim().replace(/;+\s*$/, "");
    const timeoutMs = ctx.timeoutMs ?? 60_000;
    const started = Date.now();
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const queryId = randomUUID();
      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/sql-editor/sqls/run`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.opts.token}`,
            "x-org-id": this.opts.orgId,
            "x-request-id": queryId,
            "content-type": "application/json",
          },
          body: JSON.stringify({ queryId, sql, source: "SqlEditor", limit: this.opts.limit ?? 5000 }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (res.status >= 500) {
          lastError = `HTTP ${res.status}: ${short(text, 300)}`;
          continue;
        }
        if (!res.ok) throw new DataError(`HTTP ${res.status}: ${short(text, 300)}`);
        const payload = text ? JSON.parse(text) : {};
        if (payload?.error || payload?.status === "FAILED") throw new DataError(short(JSON.stringify(payload.error ?? payload), 300));
        const { columns, rows } = toRows(payload);
        const result: QueryResult = { queryId, backend: "zetaris", columns, rows, elapsedMs: Date.now() - started, sql };
        this.trace.emit({
          agent_name: ctx.agent, action, input_summary: short(ctx.purpose), output_summary: `${rows.length} rows`,
          target_agent: ctx.targetAgent ?? null, retry_count: attempt, status: "success",
          detail: { sql, query_id: queryId, backend: "zetaris", rows: rows.length, ms: result.elapsedMs },
        });
        return result;
      } catch (err) {
        if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
          this.fail(ctx, action, sql, `timed out after ${timeoutMs} ms`, attempt);
          throw new DataTimeout(sql, timeoutMs);
        }
        if (err instanceof DataError) {
          this.fail(ctx, action, sql, err.message, attempt);
          throw err;
        }
        lastError = (err as Error).message;
      }
    }
    this.fail(ctx, action, sql, lastError, 1);
    throw new DataError(lastError);
  }

  private fail(ctx: QueryContext, action: string, sql: string, why: string, attempt: number): void {
    this.trace.emit({
      agent_name: ctx.agent, action, input_summary: short(ctx.purpose), output_summary: `failed: ${short(why)}`,
      target_agent: ctx.targetAgent ?? null, retry_count: attempt, status: "error", detail: { sql, backend: "zetaris" },
    });
  }
}
