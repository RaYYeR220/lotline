import { z } from "zod";
import type { Cte } from "@lotline/core";
import type { AgentContext } from "./context.ts";

/** Where each tracking event lives in the partner systems: table, primary key and the KDE columns. */
export interface TableRole {
  table: string;
  cte: Cte | "reference";
  pk: string;
  lot: string | null;
  date: string | null;
  qty: string | null;
  location: string | null;
}
export type SourceMap = Record<string, TableRole>;

// What a careful analyst would conclude from the column names alone; used when no model answers.
const KNOWN: SourceMap = {
  "grower.harvest": { table: "grower.harvest", cte: "harvest", pk: "harvest_lot", lot: "harvest_lot", date: "harvest_date", qty: "qty_cases", location: "farm_id" },
  "grower.cooling": { table: "grower.cooling", cte: "cooling", pk: "cool_id", lot: "harvest_lot", date: "cooled_at", qty: null, location: "cooler_location" },
  "packer.receipts": { table: "packer.receipts", cte: "receiving", pk: "receipt_id", lot: "supplier_lot", date: "received_at", qty: "qty_cases", location: "supplier_id" },
  "packer.repacks": { table: "packer.repacks", cte: "transformation", pk: "repack_id", lot: "output_lot", date: "packed_at", qty: "qty_in", location: null },
  "packer.shipments": { table: "packer.shipments", cte: "shipping", pk: "ship_id", lot: "output_lot", date: "ship_date", qty: "qty_cases", location: "customer_id" },
  "wms.receiving": { table: "wms.receiving", cte: "receiving", pk: "rcv_id", lot: "vendor_lot", date: "received_at", qty: "qty_cases", location: "vendor_id" },
  "wms.lpn": { table: "wms.lpn", cte: "reference", pk: "internal_lpn", lot: "vendor_lot", date: null, qty: null, location: null },
  "wms.store_shipments": { table: "wms.store_shipments", cte: "shipping", pk: "order_line_id", lot: "internal_lpn", date: "ship_date", qty: "qty_cases", location: "location_id" },
  "retail.receipts": { table: "retail.receipts", cte: "receiving", pk: "receipt_id", lot: "supplier_ref_lot", date: "received_at", qty: "qty_cases", location: "store_id" },
  "carrier.bol_index": { table: "carrier.bol_index", cte: "shipping", pk: "bol_no", lot: null, date: "ship_date", qty: null, location: "consignee" },
  "ref.locations": { table: "ref.locations", cte: "reference", pk: "location_id", lot: null, date: null, qty: null, location: "location_id" },
  "ref.firms": { table: "ref.firms", cte: "reference", pk: "firm_id", lot: null, date: null, qty: null, location: "location_id" },
};

const Mapping = z.object({
  tables: z.array(z.object({
    table: z.string(),
    cte: z.enum(["harvest", "cooling", "initial_packing", "shipping", "receiving", "transformation", "reference"]),
    pk: z.string(),
    lot: z.string().nullable(),
    date: z.string().nullable(),
    qty: z.string().nullable(),
    location: z.string().nullable(),
  })),
  quirks: z.array(z.object({ source: z.string(), quirk: z.string() })).default([]),
});

const SYSTEM = `You map a food distributor's partner data catalog onto FSMA 204 traceability roles.
For each table decide which Critical Tracking Event it records (harvest, cooling, initial_packing, shipping, receiving, transformation, or reference),
and which column is its primary key, its lot code, its event date, its quantity and its location. Use null when a table has no such column.
Only use column names that appear in the catalog. Also list any format quirks you notice (e.g. two systems spelling the same lot differently).
Reply with one JSON object: {"tables":[{"table","cte","pk","lot","date","qty","location"}],"quirks":[{"source","quirk"}]}.`;

/**
 * SourceMapperAgent: discovers what is registered in the data layer, maps each table to its tracking event,
 * and recalls what earlier runs learned about each partner system.
 */
export async function mapSources(ctx: AgentContext): Promise<{ map: SourceMap; quirks: Record<string, string[]> }> {
  const qctx = { agent: "SourceMapperAgent", purpose: "catalog discovery", timeoutMs: 30_000 };
  const tables = await ctx.data.listTables(qctx);
  const catalog: Record<string, string[]> = {};
  for (const t of tables) {
    const name = `${t.source}.${t.table}`;
    catalog[name] = (await ctx.data.describe(name, { ...qctx, purpose: `schema of ${name}` })).map((c) => c.name);
  }

  const quirks: Record<string, string[]> = {};
  for (const source of new Set(Object.keys(catalog).map((n) => n.split(".")[0]))) {
    const recalled = await ctx.memory.recallQuirks(source);
    if (recalled.length) quirks[source] = recalled.map((r) => r.text);
  }

  const known = Object.fromEntries(Object.entries(KNOWN).filter(([t]) => catalog[t]));
  const res = await ctx.models.chat({
    agent: "SourceMapperAgent", lane: "reason", purpose: "map catalog to tracking events",
    system: SYSTEM, user: JSON.stringify({ catalog, knownQuirks: quirks }),
    schema: Mapping, ruleFallback: () => ({ tables: Object.values(known), quirks: [] }), targetAgent: "TracerAgent", maxTokens: 3500,
  });

  // A proposed role is only accepted if every column it names exists; otherwise the known mapping stands.
  const map: SourceMap = { ...known };
  let accepted = 0;
  let overruled = 0;
  for (const t of res.json.tables) {
    const cols = catalog[t.table];
    if (!cols) continue;
    const named = [t.pk, t.lot, t.date, t.qty, t.location].filter((c): c is string => !!c);
    if (named.every((c) => cols.includes(c)) && (!KNOWN[t.table] || (t.lot ?? null) === KNOWN[t.table].lot)) {
      map[t.table] = t as TableRole;
      accepted++;
    } else overruled++;
  }
  for (const q of res.json.quirks ?? []) (quirks[q.source.split(".")[0]] ??= []).push(q.quirk);

  ctx.trace.emit({
    agent_name: "SourceMapperAgent", action: "sources.mapped", input_summary: `${Object.keys(catalog).length} tables in the data layer`,
    output_summary: `${Object.values(map).filter((r) => r.cte !== "reference").length} tracking-event tables; ${accepted} roles accepted, ${overruled} overruled; quirks for ${Object.keys(quirks).length} systems`,
    target_agent: "TracerAgent", model: res.model, status: "success", detail: { map, quirks },
  });
  return { map, quirks };
}
