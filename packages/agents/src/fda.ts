import type { Cte, Evidence, TraceLink } from "@lotline/core";
import { canonicalLot } from "./lotcodes.ts";

/** Column order of the sortable spreadsheet handed to FDA (one row per Critical Tracking Event record). */
export const FDA_COLUMNS = [
  "traceability_lot_code", "product_description", "quantity", "unit", "cte", "event_date",
  "location_description", "location_id", "reference_document_type", "reference_document_number",
  "source_system", "evidence_query_id",
] as const;

type FdaRow = Record<(typeof FDA_COLUMNS)[number], string>;

// Which CTE a partner table records, and where its KDE fields live.
const TABLE_CTE: Record<string, { cte: Cte; lot: string[]; qty: string[]; date: string[]; loc: string[]; doc?: { type: string; cols: string[] } }> = {
  "grower.harvest": { cte: "harvest", lot: ["harvest_lot"], qty: ["qty_cases"], date: ["harvest_date"], loc: ["farm_name", "farm_id", "field_id"] },
  "grower.cooling": { cte: "cooling", lot: ["harvest_lot"], qty: [], date: ["cooled_at"], loc: ["cooler_location"] },
  "packer.receipts": { cte: "receiving", lot: ["supplier_lot"], qty: ["qty_cases"], date: ["received_at"], loc: ["packer_name", "supplier_id"] },
  "packer.repacks": { cte: "transformation", lot: ["output_lot"], qty: ["qty_in"], date: ["packed_at"], loc: ["packer_name"], doc: { type: "repack record", cols: ["repack_id"] } },
  "packer.shipments": { cte: "shipping", lot: ["output_lot"], qty: ["qty_cases"], date: ["ship_date"], loc: ["customer_id"], doc: { type: "bill of lading", cols: ["bol_no"] } },
  "wms.receiving": { cte: "receiving", lot: ["vendor_lot"], qty: ["qty_cases"], date: ["received_at"], loc: ["dc_name", "vendor_id"], doc: { type: "bill of lading", cols: ["bol_no"] } },
  "wms.store_shipments": { cte: "shipping", lot: ["internal_lpn"], qty: ["qty_cases"], date: ["ship_date"], loc: ["location_id"], doc: { type: "route manifest", cols: ["route_id", "order_line_id"] } },
  "retail.receipts": { cte: "receiving", lot: ["supplier_ref_lot"], qty: ["qty_cases"], date: ["received_at"], loc: ["store_name", "store_id"], doc: { type: "store receipt", cols: ["receipt_id"] } },
  "carrier.bol_index": { cte: "shipping", lot: [], qty: [], date: ["ship_date"], loc: ["origin", "consignee"], doc: { type: "bill of lading (scan)", cols: ["bol_no", "scan_key"] } },
};

const first = (fields: Record<string, string>, cols: string[]) => cols.map((c) => fields[c]).find((v) => v != null && v !== "") ?? "";

function rowFor(link: TraceLink, e: Evidence, product: string): FdaRow {
  const qualified = `${e.source}.${e.table}`;
  const spec = TABLE_CTE[qualified] ?? TABLE_CTE[e.table] ?? (e.table.endsWith("receipts") ? TABLE_CTE["retail.receipts"] : undefined);
  const f = e.fields;
  return {
    // The traceability lot code is the one assigned at packing; receivers' drifted spellings fold back onto it.
    traceability_lot_code: canonicalLot((spec && first(f, spec.lot)) || link.from.split(":").at(-1) || ""),
    product_description: f.product_desc ?? f.commodity ?? product,
    quantity: spec ? first(f, spec.qty) : "",
    unit: spec?.qty.length ? "cases" : "",
    cte: spec?.cte ?? "shipping",
    event_date: (spec ? first(f, spec.date) : "").slice(0, 10) || link.at.slice(0, 10),
    location_description: spec ? first(f, spec.loc) : "",
    location_id: f.location_id ?? f.store_id ?? f.customer_id ?? f.farm_id ?? "",
    reference_document_type: spec?.doc?.type ?? "",
    reference_document_number: spec?.doc ? first(f, spec.doc.cols) : "",
    source_system: `${e.source}.${e.table}`,
    evidence_query_id: e.queryId,
  };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * The FDA sortable spreadsheet: every proven link contributes one row per evidence record, de-duplicated,
 * sorted by lot then date. Links that are not proven are listed separately, never mixed in.
 */
export function buildSpreadsheet(links: TraceLink[], product: string): { csv: string; rows: number; unproven: TraceLink[] } {
  const seen = new Set<string>();
  const rows: FdaRow[] = [];
  for (const link of links.filter((l) => l.status === "proven")) {
    for (const e of link.evidence) {
      const key = `${e.source}.${e.table}#${e.rowKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(rowFor(link, e, product));
    }
  }
  rows.sort((a, b) => a.traceability_lot_code.localeCompare(b.traceability_lot_code) || a.event_date.localeCompare(b.event_date) || a.cte.localeCompare(b.cte));
  const unproven = links.filter((l) => l.status === "unproven" || l.status === "contested");
  const lines = [FDA_COLUMNS.join(","), ...rows.map((r) => FDA_COLUMNS.map((c) => csvCell(r[c])).join(","))];
  if (unproven.length) {
    lines.push("", "unproven_links", "link_id,from,to,kind,date,reason");
    for (const l of unproven) lines.push([l.id, l.from, l.to, l.kind, l.at.slice(0, 10), l.notes.join(" | ")].map(csvCell).join(","));
  }
  return { csv: lines.join("\n") + "\n", rows: rows.length, unproven };
}
