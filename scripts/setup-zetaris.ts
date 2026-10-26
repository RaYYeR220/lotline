// Registers every partner system in Zetaris so agents can query them in place, then checks row counts.
//
//   npx tsx scripts/export-partners.ts --seed 7
//   docker compose -f infra/docker-compose.partners.yml up -d
//   npx tsx scripts/setup-zetaris.ts            (needs ZETARIS_API_TOKEN and ZETARIS_ORG_ID in .env)
//
// Idempotent: existing sources are dropped and registered again.
import { TraceLog, loadConfig } from "@lotline/core";
import { ZetarisClient } from "@lotline/adapters";

try { process.loadEnvFile(".env"); } catch { /* environment only */ }
const cfg = loadConfig();
if (!cfg.zetaris.token || !cfg.zetaris.orgId) {
  console.error("set ZETARIS_API_TOKEN and ZETARIS_ORG_ID in .env (Zetaris UI: Management -> API Tokens, Management -> Organisation)");
  process.exit(2);
}
const trace = new TraceLog(`setup-zetaris-${Date.now()}`, { stdout: false });
const z = new ZetarisClient({ baseUrl: cfg.zetaris.baseUrl, token: cfg.zetaris.token, orgId: cfg.zetaris.orgId }, trace);
const ctx = { agent: "Setup", purpose: "register partner sources", timeoutMs: 180_000 };

const PG_HOST = process.env.PARTNERS_PG_HOST ?? "lotline-partners-pg";
const RETAIL_URL = process.env.PARTNERS_RETAIL_URL ?? "http://lotline-retail-api:8090/receipts";
const FILES = process.env.PARTNERS_FILES_ROOT ?? "/home/zetaris/customer-data/shared/lotline";

async function run(sql: string, okIfFails = false) {
  try {
    const r = await z.writeBack(sql, ctx);
    console.log(`ok   ${sql.split("\n")[0].slice(0, 110)}`);
    return r;
  } catch (err) {
    if (!okIfFails) throw err;
    console.log(`skip ${sql.split("\n")[0].slice(0, 80)} (${(err as Error).message.slice(0, 80)})`);
    return null;
  }
}

const datasources: Record<string, string> = { packer: "Packer ERP (PostgreSQL)", wms: "Northgate WMS (PostgreSQL)", ref: "Northgate master data (PostgreSQL)" };
for (const [name, desc] of Object.entries(datasources)) {
  await run(`DROP DATASOURCE ${name}`, true);
  await run(`CREATE DATASOURCE ${name} DESCRIBE BY "${desc}" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://${PG_HOST}:5432/${name}", username "partners", password "partners", fetchsize "1000")`);
  await run(`REGISTER DATASOURCE TABLES FROM ${name}`);
}

const fileTables: [string, string, string][] = [
  ["grower", "harvest", "Grower harvest logs (CSV)"],
  ["grower", "cooling", "Grower cooling logs (CSV)"],
  ["carrier", "bol_index", "Carrier bill-of-lading index (CSV)"],
];
for (const db of ["grower", "carrier", "retail"]) {
  await run(`DROP LIGHTNING DATABASE ${db}`, true);
  await run(`CREATE LIGHTNING DATABASE ${db} DESCRIBE BY "${db} partner records"`);
}
for (const [db, table, desc] of fileTables) {
  await run(`CREATE LIGHTNING FILESTORE TABLE ${table} FROM ${db} FORMAT CSV OPTIONS (path "${FILES}/${db}/${table}.csv", header "true", inferSchema "false", delimiter ",", description "${desc}")`);
}
await run(`CREATE LIGHTNING REST TABLE receipts FROM retail REQUEST (endpoint "${RETAIL_URL}", method "GET", http_encoding "URLENCODED", response_type "JSON", insecure_ssl "true") HEADER () BODY ()`);

console.log("\nrow counts through Zetaris:");
for (const t of ["grower.harvest", "grower.cooling", "packer.receipts", "packer.repacks", "packer.shipments", "wms.receiving", "wms.lpn", "wms.store_shipments", "retail.receipts", "carrier.bol_index", "ref.locations", "ref.firms"]) {
  const r = await z.query(`SELECT COUNT(*) AS n FROM ${t}`, { ...ctx, purpose: `count ${t}` });
  console.log(`  ${t.padEnd(22)} ${Object.values(r.rows[0] ?? {})[0]}`);
}
