import {
  CHAINS, COMMODITIES, COMMODITY_IDS, DIRECT_VENDORS, FOOD_SERVICE, GROWERS, addressFor,
  type CommodityId, type Grower, type LotStyle,
} from "./catalog.ts";
import { dayToIso, weekday } from "./dates.ts";
import { directVendorLot, growerLot, packerLot } from "./lotcodes.ts";
import type { Rng } from "./rng.ts";
import type { WorldSpec } from "./types.ts";

/**
 * The physical flow of product, before any partner system writes it down.
 * Times are absolute minutes since 00:00 of day 0. Tables are rendered from
 * this model at the end, and the answer key is derived from it — never from
 * the rendered (messy) tables.
 */

export const DAY = 1440;
export const dayOf = (t: number) => Math.floor(t / DAY);

export interface Field {
  grower: Grower;
  fieldId: string;
  commodity: CommodityId;
}

export interface HarvestLot {
  code: string;
  grower: Grower;
  field: Field;
  commodity: CommodityId;
  day: number;
  qty: number;
  harvestT: number;
  cooledT: number;
  packerRcvT: number;
  coolId: string;
  receiptId: string;
  batch: PackBatch | null;
}

/** One packer transformation event: 1+ harvest lots in, one output lot out. */
export interface PackBatch {
  id: number;
  commodity: CommodityId;
  inputs: HarvestLot[];
  packT: number;
  qtyOut: number;
  /** Per-day sequence in the packer lot code; reassigned when batches change. */
  seq: number;
  repackIds: string[];
}

/** One load under one bill of lading: a single lot, from the packer or a direct vendor. */
export interface Consignment {
  id: string;
  bolNo: string;
  kind: "packer" | "direct";
  batch: PackBatch | null;
  directLot: string | null;
  vendorId: string;
  commodity: CommodityId;
  customerId: "NGP" | "BAY";
  shipT: number;
  transitMin: number;
  qty: number;
  carrierId: string;
  trailer: string;
  seal: string;
  /** Cases missing at Northgate receiving (planted quantity mismatch). */
  shortBy: number;
  /** Receiving was never keyed into the WMS; only the BOL scan shows it (planted). */
  omitReceivingRow: boolean;
  /** Days added to the WMS receiving timestamp (planted clock skew). */
  skewReceivedDays: number;
  receipt: DcReceipt | null;
}

/** A Northgate DC receipt; each one gets its own license plate (LPN). */
export interface DcReceipt {
  rcvId: string;
  lpn: string;
  consignment: Consignment;
  rcvT: number;
  qty: number;
  remaining: number;
  notes: string | null;
  lines: StoreLine[];
}

/** One outbound order line from the DC to a customer location. */
export interface StoreLine {
  id: string;
  receipt: DcReceipt;
  outlet: Outlet;
  day: number;
  qty: number;
  routeId: string;
  retailReceiptId: string | null;
}

export interface Outlet {
  locationId: string;
  kind: "store" | "food_service";
  chainId: string;
  name: string;
  city: string;
  state: string;
  address: string;
  weekdays: number[];
  carries: Set<CommodityId>;
  lotStyle: LotStyle | null;
  routeGroup: number;
}

export interface Flow {
  spec: WorldSpec;
  fields: Field[];
  harvests: HarvestLot[];
  batches: PackBatch[];
  consignments: Consignment[];
  receipts: DcReceipt[];
  lines: StoreLine[];
  outlets: Outlet[];
}

export const isoDay = (flow: Flow, day: number) => dayToIso(flow.spec.startDate, day);

export function batchCode(flow: Flow, b: PackBatch): string {
  return packerLot(isoDay(flow, dayOf(b.packT)), b.seq);
}

/** The lot code printed on the cases of a consignment (packer output lot or vendor lot). */
export function consignmentLot(flow: Flow, c: Consignment): string {
  return c.batch ? batchCode(flow, c.batch) : c.directLot!;
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

// ---------------------------------------------------------------------------
// Customers

export function buildOutlets(rng: Rng): Outlet[] {
  const outlets: Outlet[] = [];
  let n = 0;
  for (const chain of CHAINS) {
    chain.cities.forEach((city, i) => {
      n++;
      const carries = new Set<CommodityId>(
        COMMODITY_IDS.filter((c) => COMMODITIES[c].stockShare >= 1 || rng.chance(COMMODITIES[c].stockShare)),
      );
      outlets.push({
        locationId: `ST${pad(n, 2)}`,
        kind: "store",
        chainId: chain.id,
        name: `${chain.name} #${chain.storeNoBase + i} ${city}`,
        city,
        state: chain.state,
        address: addressFor(n),
        weekdays: chain.weekdays,
        carries,
        lotStyle: chain.lotStyle,
        routeGroup: Math.floor(i / 4) + 1,
      });
    });
  }
  FOOD_SERVICE.forEach((fs, i) => {
    outlets.push({
      locationId: fs.locationId,
      kind: "food_service",
      chainId: fs.firmId,
      name: fs.name,
      city: fs.city,
      state: fs.state,
      address: addressFor(100 + i),
      weekdays: fs.weekdays,
      carries: new Set(fs.carries),
      lotStyle: null,
      routeGroup: 1,
    });
  });
  return outlets;
}

/** Delivery route for an outlet on a day: one truck per four stores of a chain, one for food service. */
export function routeFor(flow: Flow, outlet: Outlet, day: number): string {
  const mmdd = isoDay(flow, day).slice(5).replace("-", "");
  return outlet.kind === "store" ? `R${mmdd}-${outlet.chainId}${outlet.routeGroup}` : `R${mmdd}-FS`;
}

// ---------------------------------------------------------------------------
// Growers → packer

export function simulateHarvests(flow: Flow, rng: Rng): void {
  const { days, startDate } = flow.spec;
  for (const grower of GROWERS) {
    const n = rng.int(grower.fieldCount[0], grower.fieldCount[1]);
    for (let k = 0; k < n; k++) {
      flow.fields.push({ grower, fieldId: `F${k + 1}`, commodity: grower.fieldPalette[k]! });
    }
  }
  for (const field of flow.fields) {
    const supply = COMMODITIES[field.commodity].supply;
    if (supply.kind !== "grown") continue;
    const [a, b] = supply.everyDays;
    for (let day = rng.int(0, b - 1); day < days; day += rng.int(a, b)) {
      const harvestT = day * DAY + rng.int(5 * 60, 9 * 60);
      let cooledT: number;
      let packerRcvT: number;
      if (field.grower.coolsAt === "farm") {
        cooledT = harvestT + rng.int(60, 240);
        packerRcvT = cooledT + rng.int(120, 360);
      } else {
        packerRcvT = harvestT + rng.int(90, 240);
        cooledT = packerRcvT + rng.int(20, 90);
      }
      flow.harvests.push({
        code: growerLot(field.grower.code, dayToIso(startDate, day), field.fieldId),
        grower: field.grower,
        field,
        commodity: field.commodity,
        day,
        qty: rng.int(supply.cases[0], supply.cases[1]),
        harvestT,
        cooledT,
        packerRcvT,
        coolId: "",
        receiptId: "",
        batch: null,
      });
    }
  }
  flow.harvests.sort((x, y) => x.harvestT - y.harvestT || x.code.localeCompare(y.code));

  // Partner record ids, numbered in the order each system would have created them.
  const coolSeq = new Map<string, number>();
  for (const h of flow.harvests) {
    const k = (coolSeq.get(h.grower.code) ?? 0) + 1;
    coolSeq.set(h.grower.code, k);
    h.coolId = `CL${h.grower.code}-${pad(k, 5)}`;
  }
  const receiptBase = rng.int(104_000, 180_000);
  [...flow.harvests]
    .sort((x, y) => x.packerRcvT - y.packerRcvT || x.code.localeCompare(y.code))
    .forEach((h, k) => (h.receiptId = `PR-${receiptBase + k}`));
}

/** Packer transformation: most output lots come from one harvest lot, some commingle two. */
export function packBatches(flow: Flow, rng: Rng): void {
  let id = 0;
  for (const commodity of COMMODITY_IDS) {
    const lots = flow.harvests
      .filter((h) => h.commodity === commodity)
      .sort((x, y) => x.packerRcvT - y.packerRcvT || x.code.localeCompare(y.code));
    if (lots.length === 0) continue;
    const groups: HarvestLot[][] = [];
    for (let i = 0; i < lots.length; ) {
      const next = lots[i + 1];
      if (next && next.packerRcvT - lots[i]!.packerRcvT <= 30 * 60 && rng.chance(0.18)) {
        groups.push([lots[i]!, next]);
        i += 2;
      } else {
        groups.push([lots[i]!]);
        i += 1;
      }
    }
    // Guarantee at least one commingled output lot per commodity: merge the two
    // single-lot groups that arrived closest together.
    if (!groups.some((g) => g.length > 1) && groups.length > 1) {
      let best = 0;
      for (let i = 1; i < groups.length - 1; i++) {
        const gap = (j: number) => groups[j + 1]![0]!.packerRcvT - groups[j]![0]!.packerRcvT;
        if (gap(i) < gap(best)) best = i;
      }
      groups.splice(best, 2, [...groups[best]!, ...groups[best + 1]!]);
    }
    for (const inputs of groups) {
      const packT = Math.max(...inputs.map((h) => h.packerRcvT)) + rng.int(90, 600);
      const qtyIn = inputs.reduce((s, h) => s + h.qty, 0);
      const batch: PackBatch = {
        id: id++,
        commodity,
        inputs,
        packT,
        qtyOut: Math.round(qtyIn * (0.95 + rng.next() * 0.04)),
        seq: 0,
        repackIds: [],
      };
      for (const h of inputs) h.batch = batch;
      flow.batches.push(batch);
    }
  }
  sortBatches(flow);
  assignSeqs(flow);
}

export function sortBatches(flow: Flow): void {
  flow.batches.sort((x, y) => x.packT - y.packT || x.id - y.id);
}

/** Packer lot sequence restarts every pack day, in pack-time order. */
export function assignSeqs(flow: Flow): void {
  const perDay = new Map<number, number>();
  for (const b of flow.batches) {
    const d = dayOf(b.packT);
    const k = (perDay.get(d) ?? 0) + 1;
    perDay.set(d, k);
    b.seq = k;
  }
}

/** Merge batch `from` into batch `into` (a forced commingle). */
export function mergeBatches(flow: Flow, into: PackBatch, from: PackBatch): void {
  into.inputs.push(...from.inputs);
  for (const h of from.inputs) h.batch = into;
  into.packT = Math.max(into.packT, from.packT);
  into.qtyOut += from.qtyOut;
  flow.batches.splice(flow.batches.indexOf(from), 1);
  sortBatches(flow);
  assignSeqs(flow);
}

// ---------------------------------------------------------------------------
// Shipments into Northgate

function newConsignment(fields: Partial<Consignment> & Pick<Consignment, "kind" | "vendorId" | "commodity" | "customerId" | "shipT" | "transitMin" | "qty" | "carrierId">): Consignment {
  return {
    id: "", bolNo: "", batch: null, directLot: null, trailer: "", seal: "",
    shortBy: 0, omitReceivingRow: false, skewReceivedDays: 0, receipt: null,
    ...fields,
  };
}

export function shipFromPacker(flow: Flow, rng: Rng): void {
  for (const batch of flow.batches) {
    const shipT = batch.packT + rng.int(60, 540);
    const carrier = () => (rng.chance(0.6) ? "RRL" : "OCF");
    let toNorthgate = batch.qtyOut;
    // Part of some lots goes to a packer customer outside the traced network.
    if (rng.chance(0.2)) {
      const external = Math.round(batch.qtyOut * (0.2 + rng.next() * 0.2));
      toNorthgate -= external;
      flow.consignments.push(newConsignment({
        kind: "packer", batch, vendorId: "PKR01", commodity: batch.commodity, customerId: "BAY",
        shipT: shipT + rng.int(0, 600), transitMin: rng.int(120, 200), qty: external, carrierId: carrier(),
      }));
    }
    const base = { kind: "packer" as const, batch, vendorId: "PKR01", commodity: batch.commodity, customerId: "NGP" as const };
    if (toNorthgate >= 60 && rng.chance(0.1)) {
      const first = Math.round(toNorthgate * (0.5 + rng.next() * 0.2));
      flow.consignments.push(newConsignment({ ...base, shipT, transitMin: rng.int(150, 270), qty: first, carrierId: carrier() }));
      flow.consignments.push(newConsignment({
        ...base, shipT: shipT + DAY + rng.int(-120, 120), transitMin: rng.int(150, 270), qty: toNorthgate - first, carrierId: carrier(),
      }));
    } else {
      flow.consignments.push(newConsignment({ ...base, shipT, transitMin: rng.int(150, 270), qty: toNorthgate, carrierId: carrier() }));
    }
  }
}

/** Non-produce items reach Northgate straight from their makers, in each maker's lot format. */
export function shipDirect(flow: Flow, rng: Rng): void {
  const transit: Record<string, [number, number]> = { ARC: [120, 180], SER: [120, 200], CSS: [300, 420] };
  const madeLag: Record<string, number> = { ARC: 2, SER: 1, CSS: 1 };
  for (const vendor of DIRECT_VENDORS) {
    const supply = COMMODITIES[vendor.commodity].supply;
    if (supply.kind !== "direct") continue;
    for (let day = 0; day < flow.spec.days; day++) {
      if (!supply.weekdays.includes(weekday(isoDay(flow, day)))) continue;
      const n = vendor.firmId === "CSS" ? rng.int(1, 12) : rng.int(1, 3);
      const [lo, hi] = transit[vendor.firmId]!;
      flow.consignments.push(newConsignment({
        kind: "direct",
        directLot: directVendorLot(vendor.firmId, isoDay(flow, day - madeLag[vendor.firmId]!), n),
        vendorId: vendor.firmId,
        commodity: vendor.commodity,
        customerId: "NGP",
        shipT: day * DAY + rng.int(180, 420),
        transitMin: rng.int(lo, hi),
        qty: rng.int(supply.cases[0], supply.cases[1]),
        carrierId: rng.chance(0.5) ? "RRL" : "OCF",
      }));
    }
  }
}

/** Ship ids, BOL numbers, trailers and seals, numbered chronologically per issuer. */
export function numberConsignments(flow: Flow, rng: Rng): void {
  flow.consignments.sort((x, y) => x.shipT - y.shipT || x.vendorId.localeCompare(y.vendorId) || x.qty - y.qty);
  const shipBase = rng.int(40_000, 70_000);
  const bolBase: Record<string, number> = { RRL: rng.int(204_000, 260_000), OCF: rng.int(31_000, 52_000) };
  const bolSeq: Record<string, number> = { RRL: 0, OCF: 0 };
  let shipSeq = 0;
  let directSeq = 0;
  for (const c of flow.consignments) {
    c.id = c.kind === "packer" ? `SHP-${shipBase + shipSeq++}` : `DV-${pad(++directSeq, 5)}`;
    const k = bolSeq[c.carrierId]!++;
    c.bolNo = c.carrierId === "RRL" ? `RRL${bolBase.RRL! + k * 3}` : `OCF-26-${pad(bolBase.OCF! + k * 2, 5)}`;
    c.trailer = `${c.carrierId === "RRL" ? "RT" : "OT"}-${rng.int(1000, 9899)}`;
    c.seal = String(rng.int(1_000_000, 9_999_999));
  }
}

// ---------------------------------------------------------------------------
// Northgate DC: receiving and store distribution

const BENIGN_NOTES = [
  "temp 34F ok", "recorder pulled, 35F", "seal intact", "pallet rewrapped at dock 3",
  "2 cs crushed - accepted", "late arrival, driver detained 40 min", "temp 36F ok, released to cooler B",
  "rcvd short dock, recount ok", "pallet tag missing, relabeled",
];

export function receiveAtDc(flow: Flow, rng: Rng): void {
  const inbound = flow.consignments
    .filter((c) => c.customerId === "NGP")
    .sort((x, y) => x.shipT + x.transitMin - (y.shipT + y.transitMin) || x.bolNo.localeCompare(y.bolNo));
  const rcvBase = rng.int(200_000, 600_000);
  const lpnBase = rng.int(30_000_000, 39_000_000);
  inbound.forEach((c, k) => {
    const qty = c.qty - c.shortBy;
    const receipt: DcReceipt = {
      rcvId: `RCV-${rcvBase + k}`,
      lpn: `L${lpnBase + k * 3 + rng.int(0, 2)}`,
      consignment: c,
      rcvT: c.shipT + c.transitMin,
      qty,
      remaining: qty,
      notes: rng.chance(0.25) ? rng.pick(BENIGN_NOTES) : null,
      lines: [],
    };
    c.receipt = receipt;
    flow.receipts.push(receipt);
  });
}

/** Pallets of one item open for picking at the same time. */
const PICK_FACES = 3;
/** Share of deliveries on which a customer reorders a given item. */
const ORDER_RATE = 0.55;

/**
 * Daily picking. Each scheduled customer reorders some of the items it carries. For
 * every item the DC keeps a few pallets (LPNs) open at separate pick faces,
 * oldest stock first, and each delivery route always picks from the same
 * face. So on any day different routes get different lots, and one LPN still
 * spreads across several stores and often several days. Order sizes are
 * calibrated so demand runs a little above supply and inventory keeps turning.
 */
export function distribute(flow: Flow, rng: Rng): void {
  const { days } = flow.spec;
  const meanOrder = new Map<CommodityId, number>();
  for (const c of COMMODITY_IDS) {
    const supply = flow.receipts.filter((r) => r.consignment.commodity === c).reduce((s, r) => s + r.qty, 0);
    let deliveries = 0;
    for (const o of flow.outlets) {
      if (!o.carries.has(c)) continue;
      for (let d = 1; d < days; d++) if (o.weekdays.includes(weekday(isoDay(flow, d)))) deliveries++;
    }
    meanOrder.set(c, deliveries > 0 ? (1.1 * supply) / (deliveries * ORDER_RATE) : 0);
  }

  const queues = new Map<CommodityId, DcReceipt[]>();
  const faces = new Map<CommodityId, (DcReceipt | null)[]>();
  for (const c of COMMODITY_IDS) {
    queues.set(c, flow.receipts.filter((r) => r.consignment.commodity === c).sort((x, y) => x.rcvT - y.rcvT || x.lpn.localeCompare(y.lpn)));
    faces.set(c, Array.from({ length: PICK_FACES }, () => null));
  }
  // Stable route numbering decides which face a route picks from.
  const routeKeys = [...new Set(flow.outlets.map((o) => (o.kind === "store" ? `${o.chainId}${o.routeGroup}` : "FS")))];
  const faceOf = (o: Outlet) => routeKeys.indexOf(o.kind === "store" ? `${o.chainId}${o.routeGroup}` : "FS") % PICK_FACES;

  // Product is put away the day it arrives and picked from the next day on.
  const nextPallet = (c: CommodityId, day: number): DcReceipt | null => {
    const open = faces.get(c)!;
    return queues.get(c)!.find((r) => dayOf(r.rcvT) <= day - 1 && r.remaining > 0 && !open.includes(r)) ?? null;
  };

  const lineBase = rng.int(1_200_000, 4_000_000);
  let lineSeq = 0;
  for (let day = 1; day < days; day++) {
    for (const c of COMMODITY_IDS) {
      const open = faces.get(c)!;
      for (let f = 0; f < PICK_FACES; f++) if (!open[f] || open[f]!.remaining === 0) open[f] = nextPallet(c, day);
    }
    const wd = weekday(isoDay(flow, day));
    for (const outlet of rng.shuffle(flow.outlets.filter((o) => o.weekdays.includes(wd)))) {
      const f = faceOf(outlet);
      for (const c of COMMODITY_IDS) {
        if (!outlet.carries.has(c) || !rng.chance(ORDER_RATE)) continue;
        const open = faces.get(c)!;
        let want = Math.max(1, Math.round(meanOrder.get(c)! * (0.6 + 0.8 * rng.next())));
        while (want > 0) {
          if (!open[f] || open[f]!.remaining === 0) open[f] = nextPallet(c, day);
          // Face empty and nothing left to replenish it: borrow from another open face.
          const r = open[f] ?? open.filter((x): x is DcReceipt => !!x && x.remaining > 0).sort((x, y) => x.rcvT - y.rcvT)[0];
          if (!r) break;
          const qty = Math.min(want, r.remaining);
          r.remaining -= qty;
          want -= qty;
          const line: StoreLine = {
            id: `OL-${lineBase + lineSeq++}`,
            receipt: r,
            outlet,
            day,
            qty,
            routeId: routeFor(flow, outlet, day),
            retailReceiptId: null,
          };
          r.lines.push(line);
          flow.lines.push(line);
        }
      }
    }
  }
}

/** Sort store lines into the order the WMS would list them. */
export function sortLines(flow: Flow): void {
  flow.lines.sort((x, y) => x.day - y.day || x.id.localeCompare(y.id));
  for (const r of flow.receipts) r.lines.sort((x, y) => x.day - y.day || x.id.localeCompare(y.id));
}
