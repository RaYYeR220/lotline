import { COMMODITIES, DIRECT_VENDORS, GROWERS, PACKER, type CommodityId } from "./catalog.ts";
import { dayToIso, longDate } from "./dates.ts";
import type { Rng } from "./rng.ts";
import { affectedBatches, type NoticePlan } from "./scenario.ts";
import { batchCode, dayOf, isoDay, type Flow } from "./simulate.ts";
import type { GeneratedNotice, RecallFields } from "./types.ts";

/**
 * FDA-style recall notices, in the shape of openFDA food-enforcement records
 * plus a free-text rendering. Some name lot codes; grower notices may only
 * give a harvest-date window and a farm, which the tracer has to resolve.
 */

const HAZARDS: Record<CommodityId, { reason: string; cls: RecallFields["classification"] }> = {
  romaine: {
    reason: "Potential contamination with Shiga toxin-producing Escherichia coli O157:H7, identified in irrigation water sampling adjacent to the harvested fields.",
    cls: "Class I",
  },
  cucumbers: {
    reason: "Potential contamination with Salmonella, detected in routine environmental sampling of the packing line.",
    cls: "Class I",
  },
  cantaloupe: {
    reason: "Potential contamination with Salmonella Typhimurium, found in FDA sampling of whole cantaloupe from the harvest lot.",
    cls: "Class I",
  },
  cilantro: {
    reason: "Potential contamination with Cyclospora cayetanensis, linked by state health officials to a cluster of illnesses.",
    cls: "Class II",
  },
  soft_cheese: {
    reason: "Product may be contaminated with Listeria monocytogenes; the organism was found in finished-product testing.",
    cls: "Class I",
  },
  tomatoes: {
    reason: "Potential contamination with Salmonella Newport associated with packing-shed wash water.",
    cls: "Class II",
  },
  bell_peppers: {
    reason: "Potential contamination with Salmonella associated with packing-shed wash water.",
    cls: "Class II",
  },
  sprouts: { reason: "Potential contamination with Listeria monocytogenes.", cls: "Class I" },
  shell_eggs: { reason: "Potential contamination with Salmonella Enteritidis.", cls: "Class I" },
  finfish: { reason: "Potential contamination with Listeria monocytogenes in the processing environment.", cls: "Class I" },
};

/** Products the network never handled, for the negative-control notice. */
const UNHANDLED = [
  {
    product: "Enoki mushrooms, 200 g (7.05 oz) clear plastic packages, product of Korea",
    firm: "Golden Crest Mushroom Co.", city: "Los Angeles", state: "CA",
    code: "Lot codes EN0826A and EN0826B, best-before dates through October 30, 2026", lots: ["EN0826A", "EN0826B"],
    reason: "Product may be contaminated with Listeria monocytogenes.", quantity: "3,240 cases",
    distribution: "Distributed to wholesalers and Asian specialty grocers in CA, NV and AZ.",
  },
  {
    product: "Whole fresh papayas, Maradol variety, 35 lb cartons",
    firm: "Sol de Bahia Imports LLC", city: "McAllen", state: "TX",
    code: "Lot code SB-2609-118, packed September 2026", lots: ["SB-2609-118"],
    reason: "Potential contamination with Salmonella Uganda.", quantity: "1,875 cartons",
    distribution: "Distributed to wholesalers in TX, OK and LA.",
  },
] as const;

/** The lot codes a notice implicates, in the recalling firm's own format. */
export function implicatedLots(flow: Flow, p: NoticePlan, unhandledLots: readonly string[] = []): string[] {
  switch (p.style) {
    case "grower-window":
    case "grower-lot":
      return p.harvests.map((h) => h.code);
    case "packer-lot":
      return p.batches.map((b) => batchCode(flow, b));
    case "vendor-lot":
      return p.directs.map((c) => c.directLot!);
    case "unhandled":
      return [...unhandledLots];
  }
}

function firmOf(id: string): { name: string; city: string; state: string } {
  const g = GROWERS.find((x) => x.firmId === id);
  if (g) return g;
  const v = DIRECT_VENDORS.find((x) => x.firmId === id);
  if (v) return v;
  if (id === PACKER.firmId) return PACKER;
  throw new Error(`unknown firm ${id}`);
}

export function renderNotices(flow: Flow, plans: NoticePlan[], rng: Rng): GeneratedNotice[] {
  const used = new Set<string>();
  const recallNumber = () => {
    let n: string;
    do n = `F-${rng.int(1000, 2999)}-2026`; while (used.has(n));
    used.add(n);
    return n;
  };
  const day = (d: number) => isoDay(flow, d);
  const plus = (iso: string, n: number) => dayToIso(iso, n);

  return plans.map((p, i): GeneratedNotice => {
    if (p.style === "unhandled") {
      const u = rng.pick(UNHANDLED);
      const initiated = day(rng.int(20, flow.spec.days - 5));
      const fields: RecallFields = {
        recall_number: recallNumber(), recalling_firm: u.firm, city: u.city, state: u.state, country: "United States",
        product_description: u.product, code_info: u.code, reason_for_recall: u.reason,
        distribution_pattern: u.distribution, classification: "Class I", product_quantity: u.quantity,
        recall_initiation_date: initiated, report_date: plus(initiated, rng.int(5, 12)),
        status: "Ongoing", voluntary_mandated: "Voluntary: Firm initiated",
      };
      return { noticeId: p.noticeId, text: renderText(fields, i), implicatedLots: [...u.lots], commodity: null, fields };
    }

    const c = COMMODITIES[p.commodity!];
    const firm = firmOf(p.firmId!);
    const lots = implicatedLots(flow, p);
    let codeInfo: string;
    let quantity: number;
    let lastDay: number;
    let distribution: string;
    switch (p.style) {
      case "grower-window": {
        const [d1, d2] = p.harvestWindow!;
        codeInfo = `All ${c.name} harvested between ${longDate(day(d1))} and ${longDate(day(d2))} from ${firm.name} (${firm.city}, ${firm.state}). Cartons carry the grower harvest lot code.`;
        quantity = p.harvests.reduce((s, h) => s + h.qty, 0);
        lastDay = d2;
        distribution = `Product was sold to a packer/cooler in ${PACKER.city}, CA, which repacked and further distributed it to wholesalers in CA and NV.`;
        break;
      }
      case "grower-lot": {
        const h = p.harvests[0]!;
        codeInfo = `Harvest lot code ${h.code} (harvested ${longDate(day(h.day))}, field ${h.field.fieldId}).`;
        quantity = h.qty;
        lastDay = h.day;
        distribution = `Product was sold to a packer/cooler in ${PACKER.city}, CA, and further distributed to wholesalers in CA and NV.`;
        break;
      }
      case "packer-lot": {
        const batches = affectedBatches(p);
        codeInfo = `Lot codes ${lots.join(" and ")} printed on the case label, packed ${batches.map((b) => longDate(day(dayOf(b.packT)))).join(" and ")}.`;
        quantity = batches.reduce((s, b) => s + b.qtyOut, 0);
        lastDay = Math.max(...batches.map((b) => dayOf(b.packT)));
        distribution = "Distributed to wholesale distributors and food service operators in CA and NV.";
        break;
      }
      case "vendor-lot": {
        codeInfo = `Lot codes ${lots.join(", ")} on the case and on each unit, with use-by dates within 30 days of production.`;
        quantity = p.directs.reduce((s, x) => s + x.qty, 0);
        lastDay = Math.max(...p.directs.map((x) => dayOf(x.shipT)));
        distribution = "Distributed to wholesale distributors in northern CA and NV for retail and food service.";
        break;
      }
    }
    const initiated = day(lastDay + rng.int(6, 10));
    const fields: RecallFields = {
      recall_number: recallNumber(),
      recalling_firm: firm.name,
      city: firm.city,
      state: firm.state,
      country: "United States",
      product_description: c.noticeProduct,
      code_info: codeInfo,
      reason_for_recall: HAZARDS[p.commodity!].reason,
      distribution_pattern: distribution,
      classification: HAZARDS[p.commodity!].cls,
      product_quantity: `${thousands(quantity)} cases`,
      recall_initiation_date: initiated,
      report_date: plus(initiated, rng.int(5, 12)),
      status: "Ongoing",
      voluntary_mandated: "Voluntary: Firm initiated",
    };
    return { noticeId: p.noticeId, text: renderText(fields, i), implicatedLots: lots, commodity: p.commodity, fields };
  });
}

/** Alternate between an enforcement-report entry and a firm press release, so intake sees both shapes. */
function renderText(f: RecallFields, i: number): string {
  if (i % 2 === 0) {
    return [
      `FDA ENFORCEMENT REPORT - FOOD`,
      `Recall number: ${f.recall_number}   Classification: ${f.classification}   Status: ${f.status}`,
      `Recalling firm: ${f.recalling_firm}, ${f.city}, ${f.state}`,
      `Product description: ${f.product_description}`,
      `Code information: ${f.code_info}`,
      `Reason for recall: ${f.reason_for_recall}`,
      `Distribution pattern: ${f.distribution_pattern}`,
      `Product quantity: ${f.product_quantity}`,
      `Recall initiation date: ${f.recall_initiation_date}   Report date: ${f.report_date}   ${f.voluntary_mandated}`,
    ].join("\n");
  }
  return [
    `${f.recalling_firm} Issues Voluntary Recall`,
    ``,
    `${f.recalling_firm} of ${f.city}, ${f.state} is voluntarily recalling ${lowerFirst(f.product_description)}. ${f.reason_for_recall}`,
    ``,
    `Affected product: ${f.code_info}`,
    `${f.distribution_pattern} Approximately ${f.product_quantity} are involved.`,
    ``,
    `The recall was initiated on ${longDate(f.recall_initiation_date)} in cooperation with the U.S. Food and Drug Administration (recall ${f.recall_number}, ${f.classification}). Customers who received the product should stop selling it and hold it for pickup.`,
  ].join("\n");
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
