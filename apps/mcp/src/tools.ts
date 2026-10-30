import type { DataLayer, QueryResult } from "@lotline/adapters";

/**
 * Zetaris for coding agents: the catalog, read-only SQL across every partner system, and three narrow writes
 * (register a partner file, publish a semantic-layer table, run a quality rule). Writes stay inside the Lotline
 * semantic-layer namespace and the partner file store; nothing here can drop a partner system.
 */
export const NAMESPACE = "lightning.metastore.lotline";
export const FILES_ROOT = process.env.PARTNERS_FILES_ROOT ?? "/home/zetaris/customer-data/shared/lotline";
const AGENT = "CodingAgent";
const IDENT = /^[a-z][a-z0-9_]{0,62}$/;

export class ToolError extends Error {}

const ident = (kind: string, v: string) => {
  if (!IDENT.test(v)) throw new ToolError(`${kind} must be lower-case letters, digits and underscores (got "${v}")`);
  return v;
};
const oneStatement = (sql: string) => {
  const s = sql.trim().replace(/;+\s*$/, "");
  if (stripLiterals(s).includes(";")) throw new ToolError("one statement per call");
  return s;
};
const stripLiterals = (sql: string) => sql.replace(/'(?:[^']|'')*'|"(?:[^"])*"|`[^`]*`/g, "''");

/** Read-only statements a coding agent may run as-is. Everything else goes through a named write tool. */
export function assertReadOnly(sql: string): string {
  const s = oneStatement(sql);
  const bare = stripLiterals(s);
  if (!/^\s*(select|with|show|describe|desc|load\s+usl)\b/i.test(bare)) throw new ToolError("run_sql is read-only: SELECT, WITH, SHOW, DESCRIBE or LOAD USL");
  const verb = bare.match(/\b(insert|update|delete|drop|create|alter|truncate|merge|grant|revoke|register|compile|activate|remove)\b/i);
  if (verb && !/^\s*load\s+usl\b/i.test(bare)) throw new ToolError(`run_sql is read-only; "${verb[1]}" belongs to a write tool`);
  return s;
}

export interface Column { name: string; type: "string" | "int" | "decimal" | "date" }
const DDL_TYPE = { string: "varchar(200)", int: "int", decimal: "decimal(18,4)", date: "varchar(30)" } as const;
const CAST_TYPE = { string: "STRING", int: "INT", decimal: "DECIMAL(18,4)", date: "STRING" } as const;

const tableOut = (r: QueryResult, limit: number) => ({
  query_id: r.queryId,
  columns: r.columns,
  rows: r.rows.slice(0, limit),
  row_count: r.rows.length,
  truncated: r.rows.length > limit,
});

export function zetarisTools(z: DataLayer) {
  if (!z.writeBack) throw new ToolError("the Zetaris client has no write path");
  const read = (sql: string, purpose: string) => z.query(sql, { agent: AGENT, purpose, timeoutMs: 120_000 });
  const write = (sql: string, purpose: string) => z.writeBack!(sql, { agent: AGENT, purpose, timeoutMs: 300_000 });

  return {
    /** Every partner system registered in Zetaris, with its tables. */
    async list_sources() {
      const tables = await z.listTables({ agent: AGENT, purpose: "catalog for a coding agent", timeoutMs: 60_000 });
      const out: Record<string, string[]> = {};
      for (const t of tables) (out[t.source] ??= []).push(t.table);
      const usl = await read(`SHOW NAMESPACES OR TABLES IN ${NAMESPACE}`, "semantic-layer tables").catch(() => null);
      return { sources: out, semantic_layer: usl?.rows ?? [] };
    },

    async describe_table(args: { table: string }) {
      return { table: args.table, columns: await z.describe(args.table, { agent: AGENT, purpose: `schema of ${args.table}`, timeoutMs: 60_000 }) };
    },

    async run_sql(args: { sql: string; limit?: number }) {
      const sql = assertReadOnly(args.sql);
      return tableOut(await read(sql, "ad-hoc query from a coding agent"), Math.min(Math.max(args.limit ?? 50, 1), 500));
    },

    /** Registers a CSV the partner dropped in the file store as a Lightning table, queryable as <database>.<table>. */
    async register_file(args: { database: string; table: string; file: string; description: string; replace?: boolean }) {
      const db = ident("database", args.database);
      const table = ident("table", args.table);
      const file = args.file.replace(/^\/+/, "");
      if (!/^[A-Za-z0-9_\-./]+\.csv$/.test(file) || file.split("/").includes("..")) throw new ToolError("file must be a .csv path inside the partner file store");
      const desc = args.description.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || table;
      if (args.replace) await write(`DROP LIGHTNING DATABASE TABLE ${db}.${table}`, `replace ${db}.${table}`).catch(() => null);
      const sql = `CREATE LIGHTNING FILESTORE TABLE ${table} FROM ${db} FORMAT CSV OPTIONS (path "${FILES_ROOT}/${file}", header "true", inferSchema "false", delimiter ",", description "${desc}")`;
      const res = await write(sql, `register partner file ${file}`);
      const columns = await z.describe(`${db}.${table}`, { agent: AGENT, purpose: `schema of ${db}.${table}`, timeoutMs: 60_000 });
      const sample = await read(`SELECT * FROM ${db}.${table} LIMIT 5`, `first rows of ${db}.${table}`);
      return { registered: `${db}.${table}`, query_id: res.queryId, columns, sample: sample.rows };
    },

    /**
     * Publishes one governed table in the Lotline semantic layer, bound to a SELECT over the partner systems in place.
     * Zetaris checks the binding against the declared model, so every column is cast and the key is never null.
     */
    async publish_semantic_table(args: { usl: string; table: string; key: string; columns: Column[]; select: string; replace?: boolean }) {
      const usl = ident("usl", args.usl);
      const table = ident("table", args.table);
      const cols = args.columns.map((c) => ({ ...c, name: ident("column", c.name) }));
      if (!cols.some((c) => c.name === args.key)) throw new ToolError(`key ${args.key} is not one of the columns`);
      const select = assertReadOnly(args.select);
      const full = `${NAMESPACE}.${usl}.${table}`;
      const steps: string[] = [];
      const step = async (sql: string, purpose: string) => { const r = await write(sql, purpose); steps.push(r.queryId); return r; };

      await step(`CREATE NAMESPACE IF NOT EXISTS lightning.metastore`, "semantic-layer root");
      await step(`CREATE NAMESPACE IF NOT EXISTS ${NAMESPACE}`, "Lotline namespace");
      if (args.replace) await write(`REMOVE USL ${usl} NAMESPACE ${NAMESPACE}`, `replace semantic layer ${usl}`).catch(() => null);
      const ddl = cols.map((c) => `  ${c.name} ${DDL_TYPE[c.type]}${c.name === args.key ? " NOT NULL PRIMARY KEY" : ""}`).join(",\n");
      await step(`COMPILE USL ${usl} DEPLOY NAMESPACE ${NAMESPACE} DDL\nCREATE TABLE ${table} (\n${ddl}\n)`, `model ${full}`);
      const bound = cols.map((c) => c.name === args.key ? `COALESCE(CAST(s.${c.name} AS STRING), '') AS ${c.name}` : `CAST(s.${c.name} AS ${CAST_TYPE[c.type]}) AS ${c.name}`).join(", ");
      await step(`ACTIVATE USL TABLE ${full} AS\nSELECT ${bound} FROM (\n${select}\n) s`, `bind ${full} to the partner systems`);
      const count = await read(`SELECT COUNT(*) AS n FROM ${full}`, `rows in ${full}`);
      return { published: full, rows: Number(Object.values(count.rows[0] ?? {})[0] ?? 0), query_ids: steps };
    },

    /** Registers a data-quality rule on a semantic-layer table and runs it. */
    async quality_check(args: { rule: string; table: string; expression: string }) {
      const rule = ident("rule", args.rule);
      if (!args.table.startsWith(`${NAMESPACE}.`)) throw new ToolError(`quality rules run on semantic-layer tables (${NAMESPACE}.<usl>.<table>)`);
      const expr = stripLiterals(args.expression);
      if (expr.includes(";") || /\b(select|drop|insert|delete)\b/i.test(expr)) throw new ToolError("expression must be a boolean column expression");
      // Registering a rule that already exists fails; the run below decides whether that mattered.
      let registerError: string | null = null;
      await write(`REGISTER DQ ${rule} TABLE ${args.table} AS ${args.expression}`, `quality rule ${rule}`).catch((e: Error) => { registerError = e.message; });
      const res = await write(`RUN DQ ${rule} TABLE ${args.table}`, `run ${rule}`).catch((e: Error) => {
        throw new ToolError(registerError ? `rule ${rule} could not be registered: ${registerError}` : e.message);
      });
      const r = res.rows[0] ?? {};
      return { rule, table: args.table, total: Number(r.total_record ?? 0), valid: Number(r.valid_record ?? 0), invalid: Number(r.invalid_record ?? 0), query_id: res.queryId };
    },
  };
}

export type ZetarisTools = ReturnType<typeof zetarisTools>;
