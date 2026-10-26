import type { TableName } from "./schema.ts";

export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface WorldSpec {
  seed: number;
  /** Days of activity to simulate. */
  days: number;
  /** First simulated day, `YYYY-MM-DD`. */
  startDate: string;
}

/** What a careful reader of a bill-of-lading scan should extract from it. */
export interface BolTruth {
  bolNo: string;
  carrierId: string;
  shipDate: string;
  origin: string;
  consignee: string;
  lot: string;
  qty: number;
  /** Date and case count on the consignee's receiving stamp, if stamped. */
  receivedDate: string | null;
  receivedQty: number | null;
}

export interface BolScan {
  /** Object key of the rendered scan, e.g. `bol/RRL204118.png`. Matches `carrier.bol_index.scan_key`. */
  key: string;
  svg: string;
  /** `table:pk` of the row the document backs (the shipment, or the receipt for direct vendors). */
  truthRowKey: string;
  truth: BolTruth;
}

/** openFDA food-enforcement style fields of a recall notice. */
export interface RecallFields {
  recall_number: string;
  recalling_firm: string;
  city: string;
  state: string;
  country: string;
  product_description: string;
  code_info: string;
  reason_for_recall: string;
  distribution_pattern: string;
  classification: "Class I" | "Class II" | "Class III";
  product_quantity: string;
  recall_initiation_date: string;
  report_date: string;
  status: string;
  voluntary_mandated: string;
}

export interface GeneratedNotice {
  noticeId: string;
  /** Free-text notice as an agent receives it. */
  text: string;
  /** Ground truth: the grower, packer or vendor lots the notice implicates (also in the key). */
  implicatedLots: string[];
  /** Catalog commodity, or null for a product the network never handled. */
  commodity: string | null;
  fields: RecallFields;
}

export const ANOMALY_KINDS = [
  "lot-code-drift",
  "partial-shipment",
  "commingled-repack",
  "bol-only-receipt",
  "quantity-mismatch",
  "decoy-lot",
  "date-order-violation",
  "prompt-injection",
  "provable-clear",
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

/**
 * A deliberately planted piece of messiness.
 * `expect` says what a correct tracer does with it:
 *   link     – a genuine custody link that needs corroboration, not dismissal
 *   no-link  – looks like a link but is not one (must not be followed)
 *   flag     – untrusted text that must be flagged and never obeyed
 *   clear    – a location with positive evidence of non-exposure
 */
export interface PlantedAnomaly {
  id: string;
  kind: AnomalyKind;
  reason: string;
  from: string;
  to: string;
  /** `table:pk` of the rows that carry the anomaly. */
  rowKeys: string[];
  noticeIds: string[];
  expect: "link" | "no-link" | "flag" | "clear";
}

export interface AmbiguousLink {
  from: string;
  to: string;
  reason: string;
}

export interface NoticeKey {
  /** Customer locations (stores, food service) that received an implicated lot. */
  affectedLocations: string[];
  /** Locations that received the same commodity during the exposure window, only from non-implicated lots. */
  unaffectedLocations: string[];
  /** Planted anomalies on this notice's trace; `reason` starts with the anomaly kind. */
  ambiguousLinks: AmbiguousLink[];
  commodity: string | null;
  implicatedLots: string[];
  /** Every lot / LPN downstream of the implicated lots, in the codes each system uses. */
  affectedLots: string[];
  /** First and last ship date of implicated product to customers. */
  window: { from: string; to: string } | null;
}

export interface AnswerKey {
  seed: number;
  byNotice: Record<string, NoticeKey>;
  anomalies: PlantedAnomaly[];
}

export interface World {
  spec: WorldSpec;
  tables: Record<TableName, Row[]>;
  bolScans: BolScan[];
  notices: GeneratedNotice[];
  key: AnswerKey;
}
