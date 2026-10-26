import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { SCHEMAS, TABLES, TABLE_NAMES, splitName } from "../schema.ts";
import type { World } from "../types.ts";

export interface DuckDbExportOptions {
  /** Also write each table as `<parquetDir>/<schema>.<table>.parquet`. */
  parquetDir?: string;
}

export interface DuckDbExportReport {
  path: string;
  bytes: number;
  tables: Record<string, number>;
}

/**
 * Write the partner tables into a DuckDB file under the same two-part names
 * Zetaris exposes (`packer.shipments`, `wms.receiving`, ...), so agent SQL runs
 * unchanged against either. Only partner data goes in — never the answer key.
 */
export async function exportDuckDb(world: World, dbPath: string, opts: DuckDbExportOptions = {}): Promise<DuckDbExportReport> {
  await mkdir(path.dirname(path.resolve(dbPath)), { recursive: true });
  await rm(dbPath, { force: true });
  await rm(`${dbPath}.wal`, { force: true });

  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const tables: Record<string, number> = {};
  try {
    for (const schema of SCHEMAS) await conn.run(`CREATE SCHEMA ${schema}`);
    for (const name of TABLE_NAMES) {
      const t = TABLES[name];
      // No PRIMARY KEY constraints: Spark SQL has none, and each index costs whole blocks in the
      // committed snapshot. Key uniqueness is checked by the generator tests instead.
      const cols = t.columns.map((c) => `${c.name} ${c.type}`).join(", ");
      await conn.run(`CREATE TABLE ${name} (${cols})`);
      const [schema, table] = splitName(name);
      const appender = await conn.createAppender(table, schema);
      for (const row of world.tables[name]) {
        for (const c of t.columns) {
          const v = row[c.name];
          if (v === null || v === undefined) appender.appendNull();
          else if (c.type === "INTEGER") appender.appendInteger(Number(v));
          else appender.appendVarchar(String(v));
        }
        appender.endRow();
      }
      appender.flushSync();
      appender.closeSync();
      tables[name] = world.tables[name].length;
    }
    if (opts.parquetDir) {
      await mkdir(opts.parquetDir, { recursive: true });
      for (const name of TABLE_NAMES) {
        const out = path.resolve(opts.parquetDir, `${name}.parquet`).replace(/\\/g, "/").replace(/'/g, "''");
        await conn.run(`COPY ${name} TO '${out}' (FORMAT parquet)`);
      }
    }
    await conn.run("CHECKPOINT");
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  return { path: dbPath, bytes: (await stat(dbPath)).size, tables };
}
