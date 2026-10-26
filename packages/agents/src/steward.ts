import type { AgentContext } from "./context.ts";
import type { SourceMap } from "./mapper.ts";

const NS = "lightning.metastore.lotline";
const USL = `${NS}.traceability`;

// Canonical traceability lot code in Spark SQL: the distributor WMS writes packer lots as PK-yyMMdd-n.
const CANON_WMS = (col: string) =>
  `CASE WHEN ${col} RLIKE '^PK-[0-9]{6}-[0-9]{1,3}$' THEN concat('PK', substr(${col}, 4, 6), lpad(substring_index(${col}, '-', -1), 3, '0')) ELSE upper(${col}) END`;

/** One row per Critical Tracking Event record across every partner system, keyed by its source row. */
function cteEventSelect(map: SourceMap): string {
  const parts = [
    `SELECT concat('grower.harvest:', h.${map["grower.harvest"].pk}) AS event_id, h.harvest_lot AS tlc, h.harvest_lot AS raw_lot, 'harvest' AS cte, CAST(h.harvest_date AS STRING) AS event_date, h.farm_id AS location_id, CAST(h.qty_cases AS INT) AS quantity, CAST(NULL AS STRING) AS reference_doc, 'grower' AS source_system FROM grower.harvest h`,
    `SELECT concat('packer.repacks:', r.repack_id), r.output_lot, r.output_lot, 'transformation', CAST(r.packed_at AS STRING), 'PACK01', CAST(r.qty_in AS INT), r.repack_id, 'packer' FROM packer.repacks r`,
    `SELECT concat('packer.shipments:', s.ship_id), s.output_lot, s.output_lot, 'shipping', CAST(s.ship_date AS STRING), s.customer_id, CAST(s.qty_cases AS INT), s.bol_no, 'packer' FROM packer.shipments s`,
    `SELECT concat('wms.receiving:', w.rcv_id), ${CANON_WMS("w.vendor_lot")}, w.vendor_lot, 'receiving', CAST(w.received_at AS STRING), 'DC01', CAST(w.qty_cases AS INT), w.bol_no, 'wms' FROM wms.receiving w`,
    `SELECT concat('wms.store_shipments:', o.order_line_id), ${CANON_WMS("l.vendor_lot")}, l.vendor_lot, 'shipping', CAST(o.ship_date AS STRING), o.location_id, CAST(o.qty_cases AS INT), o.route_id, 'wms' FROM wms.store_shipments o JOIN wms.lpn l ON o.internal_lpn = l.internal_lpn`,
  ];
  // Zetaris checks the activation query against the declared model: key not null, declared types.
  return `SELECT COALESCE(u.event_id, '') AS event_id, CAST(u.tlc AS STRING) AS tlc, CAST(u.raw_lot AS STRING) AS raw_lot, CAST(u.cte AS STRING) AS cte, CAST(u.event_date AS STRING) AS event_date, CAST(u.location_id AS STRING) AS location_id, CAST(u.quantity AS INT) AS quantity, CAST(u.reference_doc AS STRING) AS reference_doc, CAST(u.source_system AS STRING) AS source_system FROM (\n${parts.join("\nUNION ALL\n")}\n) u`;
}

const DDL = `CREATE TABLE cte_event (
  event_id varchar(80) NOT NULL PRIMARY KEY,
  tlc varchar(40),
  raw_lot varchar(40),
  cte varchar(20),
  event_date varchar(30),
  location_id varchar(20),
  quantity int,
  reference_doc varchar(40),
  source_system varchar(20)
)`;

/** Data-quality rules for the record problems this run had to argue its way around. */
const RULES: { name: string; expr: string; why: string }[] = [
  { name: "lot_code_as_assigned", expr: "raw_lot = tlc", why: "a partner spells the traceability lot code differently from the code assigned at packing" },
  { name: "shipping_has_document", expr: "cte <> 'shipping' OR reference_doc IS NOT NULL", why: "a shipping event without a bill of lading or manifest reference" },
  { name: "quantity_recorded", expr: "cte = 'cooling' OR (quantity IS NOT NULL AND quantity > 0)", why: "an event without a quantity" },
];

/**
 * DataSteward: leaves the data layer better than it found it. Publishes one governed traceability view
 * (the KDE events of every partner system, lot codes canonicalised the way the agents learned to) and
 * registers data-quality rules for the problems the run met, then reports how many records fail them.
 * Live only: in sample mode there is no Zetaris to write to.
 */
export async function stewardWriteBack(ctx: AgentContext, map: SourceMap): Promise<{ rules: { name: string; total: string; invalid: string }[] } | null> {
  if (!ctx.data.writeBack) {
    ctx.trace.emit({ agent_name: "DataSteward", action: "write_back.skipped", input_summary: "semantic layer", output_summary: "sample mode: no data layer to write to", status: "skipped" });
    return null;
  }
  const wb = (sql: string, purpose: string) => ctx.data.writeBack!(sql, { agent: "DataSteward", purpose, timeoutMs: 300_000 });
  await wb(`CREATE NAMESPACE IF NOT EXISTS lightning.metastore`, "semantic-layer root namespace");
  await wb(`CREATE NAMESPACE IF NOT EXISTS ${NS}`, "namespace for the traceability layer");
  try {
    await wb(`COMPILE USL traceability DEPLOY NAMESPACE ${NS} DDL\n${DDL}`, "compile the traceability semantic layer");
  } catch {
    // Already deployed by an earlier run: keep it and re-activate below.
  }
  await wb(`ACTIVATE USL TABLE ${USL}.cte_event AS\n${cteEventSelect(map)}`, "bind the layer to the partner systems in place");

  const out: { name: string; total: string; invalid: string }[] = [];
  for (const rule of RULES) {
    try {
      await wb(`REGISTER DQ ${rule.name} TABLE ${USL}.cte_event AS ${rule.expr}`, `quality rule: ${rule.why}`);
    } catch {
      // Registered by an earlier run.
    }
    const res = await wb(`RUN DQ ${rule.name} TABLE ${USL}.cte_event`, `run ${rule.name}`);
    const r = res.rows[0] ?? {};
    const total = String(r.total_record ?? r.total ?? "?");
    const invalid = String(r.invalid_record ?? r.invalid ?? "?");
    out.push({ name: rule.name, total, invalid });
  }
  ctx.trace.emit({
    agent_name: "DataSteward", action: "write_back.done", input_summary: `${USL}.cte_event`,
    output_summary: out.map((r) => `${r.name}: ${r.invalid} of ${r.total} records fail`).join("; "),
    status: "success", detail: { usl: `${USL}.cte_event`, rules: out },
  });
  return { rules: out };
}
