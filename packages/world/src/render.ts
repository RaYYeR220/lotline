import { renderBolSvg, type BolDoc } from "./bol.ts";
import {
  CARRIERS, CHAINS, COMMODITIES, DIRECT_VENDORS, DISTRIBUTOR, EXTERNAL_CUSTOMER, FOOD_SERVICE, GROWERS, PACKER, addressFor,
} from "./catalog.ts";
import { stamp } from "./dates.ts";
import { retailRefLot, wmsVendorLot } from "./lotcodes.ts";
import type { Rng } from "./rng.ts";
import type { TableName } from "./schema.ts";
import { DAY, batchCode, consignmentLot, dayOf, isoDay, type Consignment, type Flow } from "./simulate.ts";
import type { BolScan, Row } from "./types.ts";

/**
 * Writes the flow down the way each partner system would: its own ids, its own
 * lot-code format, its own timestamps, and the planted gaps (a missing
 * receiving row, a short count, a skewed clock, an injected note).
 */
export function renderWorld(flow: Flow, rng: Rng): { tables: Record<TableName, Row[]>; bolScans: BolScan[] } {
  const at = (t: number) => stamp(flow.spec.startDate, 0, t);
  const tables = {} as Record<TableName, Row[]>;

  tables["grower.harvest"] = flow.harvests.map((h) => ({
    harvest_lot: h.code,
    farm_id: h.grower.firmId,
    farm_name: h.grower.name,
    field_id: h.field.fieldId,
    commodity: h.commodity,
    harvest_date: isoDay(flow, h.day),
    qty_cases: h.qty,
  }));

  tables["grower.cooling"] = flow.harvests.map((h) => ({
    cool_id: h.coolId,
    harvest_lot: h.code,
    cooled_at: at(h.cooledT),
    cooler_location: h.grower.coolerName,
  }));

  tables["packer.receipts"] = [...flow.harvests]
    .sort((x, y) => x.packerRcvT - y.packerRcvT || x.code.localeCompare(y.code))
    .map((h) => ({
      receipt_id: h.receiptId,
      supplier_id: h.grower.firmId,
      supplier_lot: h.code,
      commodity: h.commodity,
      received_at: at(h.packerRcvT),
      qty_cases: h.qty,
    }));

  const repackBase = rng.int(510_000, 690_000);
  let repackSeq = 0;
  tables["packer.repacks"] = [];
  for (const b of flow.batches) {
    const out = batchCode(flow, b);
    b.repackIds = b.inputs.map(() => `RP-${repackBase + repackSeq++}`);
    b.inputs.forEach((h, i) => {
      tables["packer.repacks"].push({
        repack_id: b.repackIds[i]!,
        input_lot: h.code,
        output_lot: out,
        qty_in: h.qty,
        packed_at: at(b.packT),
      });
    });
  }

  const packerLoads = flow.consignments.filter((c) => c.kind === "packer");
  tables["packer.shipments"] = packerLoads.map((c) => ({
    ship_id: c.id,
    output_lot: batchCode(flow, c.batch!),
    customer_id: c.customerId,
    ship_date: isoDay(flow, dayOf(c.shipT)),
    qty_cases: c.qty,
    bol_no: c.bolNo,
    carrier_id: c.carrierId,
  }));

  const wmsLot = (c: Consignment) => (c.batch ? wmsVendorLot(batchCode(flow, c.batch)) : c.directLot!);
  tables["wms.receiving"] = flow.receipts
    .filter((r) => !r.consignment.omitReceivingRow)
    .map((r) => {
      const c = r.consignment;
      // Clock skew: the WMS stamps the receipt a day before the packer shipped it.
      const t = c.skewReceivedDays !== 0 ? (dayOf(c.shipT) + c.skewReceivedDays) * DAY + (r.rcvT % DAY) : r.rcvT;
      return {
        rcv_id: r.rcvId,
        vendor_id: c.vendorId,
        vendor_lot: wmsLot(c),
        internal_lpn: r.lpn,
        received_at: at(t),
        qty_cases: r.qty,
        bol_no: c.bolNo,
        notes: r.notes,
      };
    });

  tables["wms.lpn"] = flow.receipts.map((r) => ({
    internal_lpn: r.lpn,
    vendor_lot: wmsLot(r.consignment),
    commodity: r.consignment.commodity,
    product_desc: COMMODITIES[r.consignment.commodity].productDesc,
  }));

  tables["wms.store_shipments"] = flow.lines.map((l) => ({
    order_line_id: l.id,
    internal_lpn: l.receipt.lpn,
    location_id: l.outlet.locationId,
    ship_date: isoDay(flow, l.day),
    qty_cases: l.qty,
    route_id: l.routeId,
  }));

  // Each chain numbers its own receiving documents.
  const chainSeq = new Map(CHAINS.map((c) => [c.id, rng.int(100_000, 900_000)]));
  tables["retail.receipts"] = [];
  for (const l of flow.lines) {
    if (l.outlet.kind !== "store") continue;
    const k = chainSeq.get(l.outlet.chainId)!;
    chainSeq.set(l.outlet.chainId, k + 1);
    l.retailReceiptId = `${l.outlet.chainId}-${k}`;
    tables["retail.receipts"].push({
      receipt_id: l.retailReceiptId,
      chain_id: l.outlet.chainId,
      store_id: l.outlet.locationId,
      store_name: l.outlet.chainId === "HBR" ? l.outlet.name.toUpperCase() : l.outlet.name,
      supplier_ref_lot: retailRefLot(l.outlet.chainId, l.outlet.lotStyle!, consignmentLot(flow, l.receipt.consignment)),
      received_at: at(l.day * DAY + rng.int(6 * 60, 12 * 60)),
      qty_cases: l.qty,
    });
  }

  const origin = (c: Consignment) => {
    if (c.kind === "packer") return `${PACKER.name}, ${PACKER.city} ${PACKER.state}`;
    const v = DIRECT_VENDORS.find((d) => d.firmId === c.vendorId)!;
    return `${v.name}, ${v.city} ${v.state}`;
  };
  const consignee = (c: Consignment) =>
    c.customerId === "NGP"
      ? `${DISTRIBUTOR.dcName}, ${DISTRIBUTOR.city} ${DISTRIBUTOR.state}`
      : `${EXTERNAL_CUSTOMER.name}, ${EXTERNAL_CUSTOMER.city} ${EXTERNAL_CUSTOMER.state}`;
  const scanKey = (c: Consignment) => `bol/${c.bolNo}.png`;

  tables["carrier.bol_index"] = flow.consignments.map((c) => ({
    bol_no: c.bolNo,
    carrier_id: c.carrierId,
    scan_key: scanKey(c),
    ship_date: isoDay(flow, dayOf(c.shipT)),
    origin: origin(c),
    consignee: consignee(c),
  }));

  tables["ref.locations"] = referenceLocations(flow);
  tables["ref.firms"] = referenceFirms();

  const bolScans: BolScan[] = flow.consignments.map((c) => {
    const carrier = CARRIERS.find((x) => x.id === c.carrierId)!;
    const lot = consignmentLot(flow, c);
    const shipDate = isoDay(flow, dayOf(c.shipT));
    const stampDoc: BolDoc["stamp"] = c.customerId === "NGP"
      ? {
          label: "RECEIVED", date: isoDay(flow, dayOf(c.receipt!.rcvT)), cases: c.receipt!.qty,
          note: c.shortBy ? `${c.shortBy} SHORT` : null, by: "NORTHGATE PRODUCE DC - DOCK",
        }
      : { label: "DELIVERED", date: isoDay(flow, dayOf(c.shipT + c.transitMin)), cases: c.qty, note: null, by: "BAYLINE FOODSERVICE" };
    const doc: BolDoc = {
      bolNo: c.bolNo,
      carrierName: carrier.name,
      scac: carrier.scac,
      shipDate,
      trailer: c.trailer,
      seal: c.seal,
      shipper: { name: origin(c).split(",")[0]!, address: shipperAddress(c) },
      consignee: { name: consignee(c).split(",")[0]!, address: consigneeAddress(c) },
      lot,
      description: COMMODITIES[c.commodity].productDesc,
      cases: c.qty,
      weightLb: c.qty * COMMODITIES[c.commodity].caseWeightLb,
      stamp: stampDoc,
    };
    return {
      key: scanKey(c),
      svg: renderBolSvg(doc, rng.fork(`bol:${c.bolNo}`)),
      truthRowKey: c.kind === "packer" ? `packer.shipments:${c.id}` : `wms.receiving:${c.receipt!.rcvId}`,
      truth: {
        bolNo: c.bolNo,
        carrierId: c.carrierId,
        shipDate,
        origin: origin(c),
        consignee: consignee(c),
        lot,
        qty: c.qty,
        receivedDate: stampDoc.date,
        receivedQty: stampDoc.cases,
      },
    };
  });

  return { tables, bolScans };
}

function shipperAddress(c: Consignment): string {
  if (c.kind === "packer") return `${PACKER.address}, ${PACKER.city}, ${PACKER.state}`;
  const i = DIRECT_VENDORS.findIndex((d) => d.firmId === c.vendorId);
  const v = DIRECT_VENDORS[i]!;
  return `${addressFor(200 + i)}, ${v.city}, ${v.state}`;
}

function consigneeAddress(c: Consignment): string {
  return c.customerId === "NGP"
    ? `${DISTRIBUTOR.address}, ${DISTRIBUTOR.city}, ${DISTRIBUTOR.state}`
    : `${EXTERNAL_CUSTOMER.address}, ${EXTERNAL_CUSTOMER.city}, ${EXTERNAL_CUSTOMER.state}`;
}

function referenceLocations(flow: Flow): Row[] {
  const rows: Row[] = [];
  GROWERS.forEach((g, i) => rows.push({
    location_id: g.locationId, name: `${g.name} (farm)`, kind: "farm", chain_id: g.firmId,
    address: addressFor(300 + i), city: g.city, state: g.state,
  }));
  rows.push({
    location_id: PACKER.locationId, name: `${PACKER.name} packhouse`, kind: "packhouse", chain_id: PACKER.firmId,
    address: PACKER.address, city: PACKER.city, state: PACKER.state,
  });
  rows.push({
    location_id: DISTRIBUTOR.locationId, name: DISTRIBUTOR.dcName, kind: "distribution_center", chain_id: DISTRIBUTOR.firmId,
    address: DISTRIBUTOR.address, city: DISTRIBUTOR.city, state: DISTRIBUTOR.state,
  });
  for (const o of flow.outlets) {
    rows.push({
      location_id: o.locationId, name: o.name, kind: o.kind, chain_id: o.chainId,
      address: o.address, city: o.city, state: o.state,
    });
  }
  DIRECT_VENDORS.forEach((v, i) => rows.push({
    location_id: v.locationId, name: v.name, kind: "supplier", chain_id: v.firmId,
    address: addressFor(200 + i), city: v.city, state: v.state,
  }));
  rows.push({
    location_id: EXTERNAL_CUSTOMER.locationId, name: EXTERNAL_CUSTOMER.name, kind: "external_customer", chain_id: EXTERNAL_CUSTOMER.firmId,
    address: EXTERNAL_CUSTOMER.address, city: EXTERNAL_CUSTOMER.city, state: EXTERNAL_CUSTOMER.state,
  });
  return rows;
}

function referenceFirms(): Row[] {
  const rows: Row[] = [];
  for (const g of GROWERS) rows.push({ firm_id: g.firmId, name: g.name, role: "grower", location_id: g.locationId, city: g.city, state: g.state });
  rows.push({ firm_id: PACKER.firmId, name: PACKER.name, role: "packer", location_id: PACKER.locationId, city: PACKER.city, state: PACKER.state });
  rows.push({ firm_id: DISTRIBUTOR.firmId, name: DISTRIBUTOR.name, role: "distributor", location_id: DISTRIBUTOR.locationId, city: DISTRIBUTOR.city, state: DISTRIBUTOR.state });
  for (const c of CHAINS) rows.push({ firm_id: c.id, name: c.name, role: "retailer", location_id: null, city: null, state: c.state });
  for (const f of FOOD_SERVICE) rows.push({ firm_id: f.firmId, name: f.name, role: "food_service", location_id: f.locationId, city: f.city, state: f.state });
  for (const v of DIRECT_VENDORS) rows.push({ firm_id: v.firmId, name: v.name, role: "supplier", location_id: v.locationId, city: v.city, state: v.state });
  for (const c of CARRIERS) rows.push({ firm_id: c.id, name: c.name, role: "carrier", location_id: null, city: c.city, state: c.state });
  rows.push({
    firm_id: EXTERNAL_CUSTOMER.firmId, name: EXTERNAL_CUSTOMER.name, role: "external_customer",
    location_id: EXTERNAL_CUSTOMER.locationId, city: EXTERNAL_CUSTOMER.city, state: EXTERNAL_CUSTOMER.state,
  });
  return rows;
}
