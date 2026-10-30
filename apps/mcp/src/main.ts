// Zetaris MCP server for coding agents working on Lotline (stdio). Configure it in .cursor/mcp.json.
// stdout carries the protocol; logs go to logs/mcp-<date>.jsonl and stderr.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TraceLog, loadConfig } from "@lotline/core";
import { ZetarisClient } from "@lotline/adapters";
import { FILES_ROOT, NAMESPACE, ToolError, zetarisTools } from "./tools.ts";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
try { process.loadEnvFile(".env"); } catch { /* environment only */ }
const cfg = loadConfig();
if (!cfg.zetaris.token || !cfg.zetaris.orgId) {
  console.error("zetaris mcp: set ZETARIS_API_TOKEN and ZETARIS_ORG_ID in .env");
  process.exit(2);
}
const trace = new TraceLog(`mcp-${new Date().toISOString().slice(0, 10)}`, { stdout: false });
const tools = zetarisTools(new ZetarisClient({ baseUrl: cfg.zetaris.baseUrl, token: cfg.zetaris.token, orgId: cfg.zetaris.orgId }, trace));

const server = new McpServer({ name: "zetaris-lotline", version: "0.1.0" }, {
  instructions: `Zetaris is Lotline's data layer: every partner system (grower files, packer ERP, distributor WMS, retail chains' receiving API, carrier index) is queryable in place as <source>.<table> in Spark SQL.
Start with list_sources and describe_table. run_sql is read-only. Column names with spaces or dashes need backquotes.
Partner files live under ${FILES_ROOT}; register one with register_file. Governed tables go in the semantic layer under ${NAMESPACE} via publish_semantic_table.`,
});

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const wrap = <A,>(name: string, fn: (a: A) => Promise<unknown>) => async (args: A) => {
  try {
    const out = await fn(args);
    trace.emit({ agent_name: "CodingAgent", action: `mcp.${name}`, input_summary: JSON.stringify(args).slice(0, 200), output_summary: JSON.stringify(out).slice(0, 200), status: "success" });
    return ok(out);
  } catch (err) {
    const message = (err as Error).message;
    trace.emit({ agent_name: "CodingAgent", action: `mcp.${name}`, input_summary: JSON.stringify(args).slice(0, 200), output_summary: `failed: ${message.slice(0, 180)}`, status: "error" });
    return { content: [{ type: "text" as const, text: err instanceof ToolError ? message : `Zetaris: ${message}` }], isError: true };
  }
};

server.registerTool("list_sources", {
  description: "Every partner system registered in Zetaris with its tables, plus the tables in Lotline's semantic layer.",
  inputSchema: {},
}, wrap("list_sources", () => tools.list_sources()));

server.registerTool("describe_table", {
  description: "Columns and types of one table, e.g. retail.receipts or wms.store_shipments.",
  inputSchema: { table: z.string().describe("<source>.<table>") },
}, wrap("describe_table", (a: { table: string }) => tools.describe_table(a)));

server.registerTool("run_sql", {
  description: "Run one read-only Spark SQL statement through Zetaris across any partner systems (joins across sources work). Returns rows and the Zetaris query id.",
  inputSchema: { sql: z.string(), limit: z.number().int().min(1).max(500).optional().describe("rows to return, default 50") },
}, wrap("run_sql", (a: { sql: string; limit?: number }) => tools.run_sql(a)));

server.registerTool("register_file", {
  description: `Register a CSV a partner dropped in the file store (${FILES_ROOT}) as a Lightning table <database>.<table>. Returns its columns and first rows.`,
  inputSchema: {
    database: z.string().describe("existing Lightning database, e.g. retail"),
    table: z.string().describe("new table name, lower_snake_case"),
    file: z.string().describe("path inside the file store, e.g. lakeview/receipts.csv"),
    description: z.string(),
    replace: z.boolean().optional(),
  },
}, wrap("register_file", (a: { database: string; table: string; file: string; description: string; replace?: boolean }) => tools.register_file(a)));

server.registerTool("publish_semantic_table", {
  description: `Publish a governed table ${NAMESPACE}.<usl>.<table> bound to a SELECT over the partner systems in place. Declare every column the SELECT returns; the key must never be null.`,
  inputSchema: {
    usl: z.string().describe("semantic-layer model name, e.g. receiving"),
    table: z.string(),
    key: z.string().describe("primary-key column"),
    columns: z.array(z.object({ name: z.string(), type: z.enum(["string", "int", "decimal", "date"]) })),
    select: z.string().describe("SELECT returning exactly the declared columns"),
    replace: z.boolean().optional().describe("replace an existing model of the same name"),
  },
}, wrap("publish_semantic_table", (a: Parameters<typeof tools.publish_semantic_table>[0]) => tools.publish_semantic_table(a)));

server.registerTool("quality_check", {
  description: "Register a data-quality rule (a boolean expression every row should satisfy) on a semantic-layer table and run it.",
  inputSchema: { rule: z.string(), table: z.string().describe(`${NAMESPACE}.<usl>.<table>`), expression: z.string() },
}, wrap("quality_check", (a: { rule: string; table: string; expression: string }) => tools.quality_check(a)));

await server.connect(new StdioServerTransport());
console.error(`zetaris mcp: ready (${cfg.zetaris.baseUrl})`);
