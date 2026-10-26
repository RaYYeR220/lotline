import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderBolPngAsync } from "../bol.ts";
import { CHAINS } from "../catalog.ts";
import { TABLES, TABLE_NAMES } from "../schema.ts";
import type { Cell, World } from "../types.ts";

export interface FileExportOptions {
  /** Where the answer key goes. Kept apart from `outDir` so nothing that serves partner data can ship it. */
  keysDir?: string;
  /** Render at most this many BOL scans (all by default). */
  scanLimit?: number;
}

export interface FileExportReport {
  outDir: string;
  tables: Record<string, number>;
  scans: number;
  noticesPath: string;
  keyPath: string;
}

/**
 * Plain-file export:
 *   <out>/tables/<schema>.<table>.csv     one CSV per table (object storage, CSV sources)
 *   <out>/tables/<schema>.<table>.jsonl   newline-delimited JSON, typed per tables/schema.json (Parquet-ready)
 *   <out>/tables/schema.json              column names and types, primary keys, CTE per table
 *   <out>/bol/<bol_no>.png                rendered bill-of-lading scans
 *   <out>/retail/<chain>.json             per-chain receiving records for the retail API fixture
 *   <out>/notices/notices.json            notices as agents receive them (no ground truth)
 *   <keys>/seed-<n>.json                  answer key
 */
export async function exportFiles(world: World, outDir: string, opts: FileExportOptions = {}): Promise<FileExportReport> {
  const keysDir = opts.keysDir ?? path.join(path.dirname(path.resolve(outDir)), "keys");
  const dirs = ["tables", "bol", "retail", "notices"].map((d) => path.join(outDir, d));
  await Promise.all([...dirs, keysDir].map((d) => mkdir(d, { recursive: true })));

  const counts: Record<string, number> = {};
  for (const name of TABLE_NAMES) {
    const schema = TABLES[name];
    const rows = world.tables[name];
    const cols = schema.columns.map((c) => c.name);
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c] ?? null)).join(","))].join("\n") + "\n";
    const jsonl = rows.map((r) => JSON.stringify(Object.fromEntries(cols.map((c) => [c, r[c] ?? null])))).join("\n") + "\n";
    await writeFile(path.join(outDir, "tables", `${name}.csv`), csv);
    await writeFile(path.join(outDir, "tables", `${name}.jsonl`), jsonl);
    counts[name] = rows.length;
  }
  await writeFile(path.join(outDir, "tables", "schema.json"), JSON.stringify(Object.values(TABLES), null, 2) + "\n");

  const scans = world.bolScans.slice(0, opts.scanLimit ?? world.bolScans.length);
  for (let i = 0; i < scans.length; i += 8) {
    await Promise.all(scans.slice(i, i + 8).map(async (scan) => {
      await writeFile(path.join(outDir, scan.key), await renderBolPngAsync(scan.svg));
    }));
  }

  for (const chain of CHAINS) {
    const rows = world.tables["retail.receipts"].filter((r) => r.chain_id === chain.id);
    await writeFile(path.join(outDir, "retail", `${chain.id}.json`), JSON.stringify({ chain_id: chain.id, name: chain.name, receipts: rows }, null, 2) + "\n");
  }

  const noticesPath = path.join(outDir, "notices", "notices.json");
  await writeFile(noticesPath, JSON.stringify(publicNotices(world), null, 2) + "\n");

  const keyPath = path.join(keysDir, `seed-${world.spec.seed}.json`);
  await writeFile(keyPath, JSON.stringify({ spec: world.spec, ...world.key }, null, 2) + "\n");

  return { outDir, tables: counts, scans: scans.length, noticesPath, keyPath };
}

/** Notices as an agent receives them: text and openFDA-style fields, no ground truth. */
export function publicNotices(world: World): { noticeId: string; text: string; fields: World["notices"][number]["fields"] }[] {
  return world.notices.map((n) => ({ noticeId: n.noticeId, text: n.text, fields: n.fields }));
}

function csvCell(v: Cell): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
