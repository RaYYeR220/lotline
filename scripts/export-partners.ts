// Writes the partner systems for a seeded world so Zetaris can serve them in place:
//   infra/partners/seed/postgres/   init SQL + CSVs for the packer, WMS and reference databases (PostgreSQL)
//   infra/partners/seed/files/      grower and carrier CSVs + bill-of-lading scans (file store)
//   infra/partners/seed/retail/     the retail chains' receiving records served by the retail API (REST/JSON)
//
//   npx tsx scripts/export-partners.ts --seed 7
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_SPEC, TABLES, generateWorld, renderBolPng, type TableName } from "../packages/world/src/index.ts";

const { values } = parseArgs({ options: { seed: { type: "string", default: String(DEFAULT_SPEC.seed) }, out: { type: "string", default: "infra/partners/seed" } } });
const world = generateWorld({ ...DEFAULT_SPEC, seed: Number(values.seed) });
const out = path.resolve(values.out!);
rmSync(out, { recursive: true, force: true });

const csvCell = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (name: TableName) => {
  const cols = TABLES[name].columns.map((c) => c.name);
  return [cols.join(","), ...world.tables[name].map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
};

// PostgreSQL: one database per partner system that runs one (packer ERP, distributor WMS, distributor master data).
const pgDir = path.join(out, "postgres");
mkdirSync(pgDir, { recursive: true });
const databases: Record<string, TableName[]> = {
  packer: ["packer.receipts", "packer.repacks", "packer.shipments"],
  wms: ["wms.receiving", "wms.lpn", "wms.store_shipments"],
  ref: ["ref.locations", "ref.firms"],
};
const init: string[] = [];
for (const [db, tables] of Object.entries(databases)) {
  init.push(`CREATE DATABASE ${db};`, `\\connect ${db}`);
  for (const t of tables) {
    const table = t.split(".")[1];
    const cols = TABLES[t].columns.map((c) => `${c.name} ${c.type === "INTEGER" ? "INTEGER" : "VARCHAR"}`).join(", ");
    init.push(`CREATE TABLE public.${table} (${cols}, PRIMARY KEY (${TABLES[t].pk}));`);
    init.push(`COPY public.${table} FROM '/seed/${t}.csv' WITH (FORMAT csv, HEADER true);`);
    writeFileSync(path.join(pgDir, `${t}.csv`), toCsv(t));
  }
}
writeFileSync(path.join(pgDir, "01-partners.sql"), init.join("\n") + "\n");

// Files: grower spreadsheets and the carrier's bill-of-lading index and scans.
const fileDir = path.join(out, "files");
for (const t of ["grower.harvest", "grower.cooling", "carrier.bol_index"] as TableName[]) {
  const dir = path.join(fileDir, t.split(".")[0]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${t.split(".")[1]}.csv`), toCsv(t));
}
mkdirSync(path.join(fileDir, "carrier", "bol"), { recursive: true });
for (const scan of world.bolScans) writeFileSync(path.join(fileDir, "carrier", scan.key), renderBolPng(scan.svg));

// REST: retail receiving, as the chains' integration API returns it.
const retailDir = path.join(out, "retail");
mkdirSync(retailDir, { recursive: true });
writeFileSync(path.join(retailDir, "receipts.json"), JSON.stringify(world.tables["retail.receipts"]));

console.log(`partners for seed ${values.seed} written to ${path.relative(process.cwd(), out)}: ${Object.values(databases).flat().length} PostgreSQL tables, 3 file tables, ${world.bolScans.length} scans, ${world.tables["retail.receipts"].length} retail receipts`);
