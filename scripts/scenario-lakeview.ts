// Scenario: Lakeview Markets stops posting receipts to the retail chains' API and sends a nightly CSV export instead.
//
//   npx tsx scripts/scenario-lakeview.ts            write the CSV, take Lakeview off the API, restart the partner systems
//   npx tsx scripts/scenario-lakeview.ts --reset    put Lakeview back on the API
//
// The export is Lakeview's own format: their column names, US dates, lot codes without the chain prefix.
// Nothing is registered in Zetaris here; onboarding the file is the point of the scenario.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TraceLog, loadConfig } from "@lotline/core";
import { ZetarisClient } from "@lotline/adapters";

const SEED = path.resolve("infra/partners/seed");
const reset = process.argv.includes("--reset");

interface Receipt { receipt_id: string; chain_id: string; store_id: string; store_name: string; supplier_ref_lot: string; received_at: string; qty_cases: number }

const all: Receipt[] = JSON.parse(readFileSync(path.join(SEED, "retail/receipts.json"), "utf8"));
const lakeview = all.filter((r) => r.chain_id === "LKV");

const usDate = (iso: string) => {
  const [d, t] = iso.split(" ");
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y} ${t.slice(0, 5)}`;
};
const csv = [
  "Receipt No,Ship-To,Store,Vendor Lot,Received,Cases",
  ...lakeview.map((r) => [r.receipt_id.replace(/^LKV-/, ""), r.store_id, `"${r.store_name.replace(/^Lakeview Markets /, "")}"`, r.supplier_ref_lot.replace(/^LKV:/, ""), usDate(r.received_at), r.qty_cases].join(",")),
].join("\n") + "\n";

mkdirSync(path.join(SEED, "files/lakeview"), { recursive: true });
writeFileSync(path.join(SEED, "files/lakeview/receipts.csv"), csv);
writeFileSync(path.join(SEED, "retail/receipts-api.json"), JSON.stringify(reset ? all : all.filter((r) => r.chain_id !== "LKV")));

// The retail API reads receipts-api.json; the file copier puts lakeview/receipts.csv into the Zetaris file store.
const compose = ["compose", "-f", "infra/docker-compose.partners.yml"];
execFileSync("docker", [...compose, "up", "-d", "--force-recreate", "retail-api", "partner-files"], { stdio: "inherit" });

// Undo any earlier onboarding so the scenario starts where a distributor would: a file nobody has registered.
try { process.loadEnvFile(".env"); } catch { /* environment only */ }
const cfg = loadConfig();
if (cfg.zetaris.token && cfg.zetaris.orgId) {
  const z = new ZetarisClient({ baseUrl: cfg.zetaris.baseUrl, token: cfg.zetaris.token, orgId: cfg.zetaris.orgId }, new TraceLog(`scenario-lakeview-${Date.now()}`, { stdout: false }));
  const ctx = { agent: "Scenario", purpose: "reset Lakeview onboarding", timeoutMs: 120_000 };
  for (const sql of ["DROP LIGHTNING DATABASE TABLE retail.lakeview_receipts", "REMOVE USL receiving NAMESPACE lightning.metastore.lotline"]) {
    await z.writeBack(sql, ctx).then(() => console.log(`reset: ${sql}`), () => {});
  }
}
console.log(reset
  ? `Lakeview back on the retail API (${all.length} receipts).`
  : `Lakeview off the retail API: ${all.length - lakeview.length} receipts left there; ${lakeview.length} rows in lakeview/receipts.csv.`);
