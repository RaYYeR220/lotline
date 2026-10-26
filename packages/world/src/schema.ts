import type { Cte } from "@lotline/core";

/**
 * Partner-system table catalog. Names are fixed two-part names so the same SQL
 * runs against Zetaris and against the DuckDB sample snapshot. Column types are
 * deliberately plain (dates and timestamps are ISO strings) to stay portable
 * between DuckDB and Spark SQL.
 */
export type ColumnType = "VARCHAR" | "INTEGER";

export interface TableSchema {
  name: TableName;
  /** Stable primary key column — every row has a unique, non-null value here. */
  pk: string;
  /** Which partner system the table lives in, for exporters that split by system. */
  system: "grower" | "packer" | "wms" | "retail" | "carrier" | "ref";
  /** The FSMA 204 critical tracking event the rows record, if any. */
  cte: Cte | null;
  columns: { name: string; type: ColumnType }[];
}

export const TABLE_NAMES = [
  "grower.harvest",
  "grower.cooling",
  "packer.receipts",
  "packer.repacks",
  "packer.shipments",
  "wms.receiving",
  "wms.lpn",
  "wms.store_shipments",
  "retail.receipts",
  "carrier.bol_index",
  "ref.locations",
  "ref.firms",
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

export const SCHEMAS = ["grower", "packer", "wms", "retail", "carrier", "ref"] as const;

const v = (name: string) => ({ name, type: "VARCHAR" as const });
const i = (name: string) => ({ name, type: "INTEGER" as const });

export const TABLES: Record<TableName, TableSchema> = {
  "grower.harvest": {
    name: "grower.harvest", pk: "harvest_lot", system: "grower", cte: "harvest",
    columns: [v("harvest_lot"), v("farm_id"), v("farm_name"), v("field_id"), v("commodity"), v("harvest_date"), i("qty_cases")],
  },
  "grower.cooling": {
    name: "grower.cooling", pk: "cool_id", system: "grower", cte: "cooling",
    columns: [v("cool_id"), v("harvest_lot"), v("cooled_at"), v("cooler_location")],
  },
  "packer.receipts": {
    name: "packer.receipts", pk: "receipt_id", system: "packer", cte: "receiving",
    columns: [v("receipt_id"), v("supplier_id"), v("supplier_lot"), v("commodity"), v("received_at"), i("qty_cases")],
  },
  "packer.repacks": {
    name: "packer.repacks", pk: "repack_id", system: "packer", cte: "transformation",
    columns: [v("repack_id"), v("input_lot"), v("output_lot"), i("qty_in"), v("packed_at")],
  },
  "packer.shipments": {
    name: "packer.shipments", pk: "ship_id", system: "packer", cte: "shipping",
    columns: [v("ship_id"), v("output_lot"), v("customer_id"), v("ship_date"), i("qty_cases"), v("bol_no"), v("carrier_id")],
  },
  "wms.receiving": {
    name: "wms.receiving", pk: "rcv_id", system: "wms", cte: "receiving",
    columns: [v("rcv_id"), v("vendor_id"), v("vendor_lot"), v("internal_lpn"), v("received_at"), i("qty_cases"), v("bol_no"), v("notes")],
  },
  "wms.lpn": {
    name: "wms.lpn", pk: "internal_lpn", system: "wms", cte: null,
    columns: [v("internal_lpn"), v("vendor_lot"), v("commodity"), v("product_desc")],
  },
  "wms.store_shipments": {
    name: "wms.store_shipments", pk: "order_line_id", system: "wms", cte: "shipping",
    columns: [v("order_line_id"), v("internal_lpn"), v("location_id"), v("ship_date"), i("qty_cases"), v("route_id")],
  },
  "retail.receipts": {
    name: "retail.receipts", pk: "receipt_id", system: "retail", cte: "receiving",
    columns: [v("receipt_id"), v("chain_id"), v("store_id"), v("store_name"), v("supplier_ref_lot"), v("received_at"), i("qty_cases")],
  },
  "carrier.bol_index": {
    name: "carrier.bol_index", pk: "bol_no", system: "carrier", cte: "shipping",
    columns: [v("bol_no"), v("carrier_id"), v("scan_key"), v("ship_date"), v("origin"), v("consignee")],
  },
  "ref.locations": {
    name: "ref.locations", pk: "location_id", system: "ref", cte: null,
    columns: [v("location_id"), v("name"), v("kind"), v("chain_id"), v("address"), v("city"), v("state")],
  },
  "ref.firms": {
    name: "ref.firms", pk: "firm_id", system: "ref", cte: null,
    columns: [v("firm_id"), v("name"), v("role"), v("location_id"), v("city"), v("state")],
  },
};

/** "packer.shipments" → ["packer", "shipments"]. */
export function splitName(name: TableName): [string, string] {
  const [schema, table] = name.split(".");
  return [schema!, table!];
}
