/**
 * Reference tracer for the tests. It walks the rendered partner tables using
 * exact lot identities (case and separators ignored, nothing fuzzy) and
 * recomputes what the answer key claims. The generator derives its key from
 * its internal flow model, so agreement here means the tables really carry
 * the trace the key describes.
 */
type Row = Record<string, string | number | null>;
type Tables = Record<string, Row[]>;

const canon = (code: string) => code.replace(/[^0-9a-z]/gi, "").toUpperCase();
const str = (v: unknown) => (v == null ? "" : String(v));

export interface ReferenceResult {
  affected: string[];
  unaffected: string[];
  window: { from: string; to: string } | null;
}

export function referenceTrace(tables: Tables, implicatedLots: string[], commodity: string | null): ReferenceResult {
  // Directed graph over typed nodes: lot → lot (repack), lot → lpn (WMS label), lpn → location (store shipment).
  const edges = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a)!.add(b);
  };
  for (const r of tables["packer.repacks"]!) link(`lot:${canon(str(r.input_lot))}`, `lot:${canon(str(r.output_lot))}`);
  for (const r of tables["wms.lpn"]!) link(`lot:${canon(str(r.vendor_lot))}`, `lpn:${str(r.internal_lpn)}`);
  for (const r of tables["wms.store_shipments"]!) link(`lpn:${str(r.internal_lpn)}`, `loc:${str(r.location_id)}`);

  const seen = new Set<string>();
  const queue = implicatedLots.map((l) => `lot:${canon(l)}`);
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const n of edges.get(node) ?? []) queue.push(n);
  }

  const affected = [...seen].filter((n) => n.startsWith("loc:")).map((n) => n.slice(4)).sort();
  const reachedLpns = new Set([...seen].filter((n) => n.startsWith("lpn:")).map((n) => n.slice(4)));

  const shipDates = tables["wms.store_shipments"]!
    .filter((r) => reachedLpns.has(str(r.internal_lpn)))
    .map((r) => str(r.ship_date))
    .sort();
  if (shipDates.length === 0 || commodity === null) return { affected, unaffected: [], window: null };
  const window = { from: shipDates[0]!, to: shipDates[shipDates.length - 1]! };

  const lpnCommodity = new Map(tables["wms.lpn"]!.map((r) => [str(r.internal_lpn), str(r.commodity)]));
  const affectedSet = new Set(affected);
  const unaffected = new Set<string>();
  for (const r of tables["wms.store_shipments"]!) {
    const d = str(r.ship_date);
    if (d < window.from || d > window.to) continue;
    if (lpnCommodity.get(str(r.internal_lpn)) !== commodity) continue;
    const loc = str(r.location_id);
    if (!affectedSet.has(loc)) unaffected.add(loc);
  }
  return { affected, unaffected: [...unaffected].sort(), window };
}
