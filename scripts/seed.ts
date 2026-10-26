/**
 * Generate a seeded partner world and export it.
 *
 *   npx tsx scripts/seed.ts --seed 7 --out data/generated
 *
 * Writes:
 *   <out>/                 per-table CSV + JSONL, BOL scans (PNG), notices, retail fixtures, Parquet
 *   <db>                   DuckDB snapshot with the partner schemas (default for seed 7: data/sample/world.duckdb)
 *   <keys>/seed-<n>.json   answer key (default eval/keys) — never under <out> or inside the snapshot
 *   data/sample/           (seed 7 only) public notices and the BOL scans the sample-mode run needs
 *
 * Options: --seed <n> --days <n> --start YYYY-MM-DD --out <dir> --db <file> --keys <dir> --no-sample --scan-limit <n>
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_SPEC, exportDuckDb, exportFiles, generateWorld, publicNotices, renderBolPng,
} from "../packages/world/src/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SAMPLE_SEED = 7;

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: String(DEFAULT_SPEC.seed) },
    days: { type: "string", default: String(DEFAULT_SPEC.days) },
    start: { type: "string", default: DEFAULT_SPEC.startDate },
    out: { type: "string", default: path.join(ROOT, "data", "generated") },
    db: { type: "string" },
    keys: { type: "string", default: path.join(ROOT, "eval", "keys") },
    "no-sample": { type: "boolean", default: false },
    "scan-limit": { type: "string" },
  },
});

const seed = Number(values.seed);
const spec = { seed, days: Number(values.days), startDate: values.start! };
const out = path.resolve(values.out!);
const isSample = seed === SAMPLE_SEED && !values["no-sample"];
const dbPath = path.resolve(values.db ?? (isSample ? path.join(ROOT, "data", "sample", "world.duckdb") : path.join(out, "world.duckdb")));

const t0 = Date.now();
const world = generateWorld(spec);
console.log(`generated world seed=${seed} days=${spec.days} start=${spec.startDate} in ${Date.now() - t0} ms`);

const files = await exportFiles(world, out, {
  keysDir: path.resolve(values.keys!),
  scanLimit: values["scan-limit"] ? Number(values["scan-limit"]) : undefined,
});
const db = await exportDuckDb(world, dbPath, { parquetDir: path.join(out, "parquet") });

if (isSample) {
  // Sample mode reads notices from here and needs the scans DocReader is asked to read:
  // the BOLs that back a planted anomaly.
  const sampleDir = path.join(ROOT, "data", "sample");
  await mkdir(path.join(sampleDir, "bol"), { recursive: true });
  await writeFile(path.join(sampleDir, "notices.json"), JSON.stringify(publicNotices(world), null, 2) + "\n");
  const bolNos = new Set(
    world.key.anomalies.flatMap((a) => a.rowKeys).filter((k) => k.startsWith("carrier.bol_index:")).map((k) => k.split(":")[1]),
  );
  for (const scan of world.bolScans.filter((s) => bolNos.has(s.truth.bolNo))) {
    await writeFile(path.join(sampleDir, scan.key), renderBolPng(scan.svg));
  }
  console.log(`sample: ${sampleDir} (notices.json + ${bolNos.size} BOL scans)`);
}

const width = Math.max(...Object.keys(files.tables).map((k) => k.length));
for (const [name, n] of Object.entries(files.tables)) console.log(`  ${name.padEnd(width)}  ${n}`);
console.log(`files:  ${files.outDir} (${files.scans} scans)`);
console.log(`duckdb: ${db.path} (${(db.bytes / 1024).toFixed(0)} KiB)`);
console.log(`key:    ${files.keyPath}`);
console.log(`notices: ${world.notices.length}, planted anomalies: ${world.key.anomalies.length}`);
