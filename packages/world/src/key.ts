import { wmsVendorLot } from "./lotcodes.ts";
import { affectedBatches, affectedConsignments, affectedLines, type NoticePlan } from "./scenario.ts";
import { batchCode, isoDay, type Flow } from "./simulate.ts";
import type { AnswerKey, GeneratedNotice, NoticeKey, PlantedAnomaly } from "./types.ts";

/**
 * The answer key, derived from the physical flow (what actually moved where),
 * not from the partner tables. Tests check the two agree by re-walking the
 * tables with exact lot identities.
 *
 * affected   — customer locations that received any implicated product.
 * unaffected — customer locations that received the same commodity while
 *              implicated product was going out (the exposure window), but only
 *              from clean lots: positive evidence of non-exposure.
 */
export function computeKey(
  flow: Flow,
  plans: NoticePlan[],
  notices: GeneratedNotice[],
  anomalies: PlantedAnomaly[],
  seed: number,
): AnswerKey {
  const byNotice: Record<string, NoticeKey> = {};
  for (const p of plans) {
    const notice = notices.find((n) => n.noticeId === p.noticeId)!;
    const ambiguousLinks = anomalies
      .filter((a) => a.noticeIds.includes(p.noticeId))
      .map((a) => ({ from: a.from, to: a.to, reason: `${a.kind}: ${a.reason}` }));

    const lines = affectedLines(flow, p);
    if (p.commodity === null || lines.length === 0) {
      byNotice[p.noticeId] = {
        affectedLocations: [], unaffectedLocations: [], ambiguousLinks,
        commodity: p.commodity, implicatedLots: notice.implicatedLots, affectedLots: [], window: null,
      };
      continue;
    }

    const affected = new Set(lines.map((l) => l.outlet.locationId));
    const days = lines.map((l) => l.day);
    const from = Math.min(...days);
    const to = Math.max(...days);
    const unaffected = new Set(
      flow.lines
        .filter((l) => l.day >= from && l.day <= to && l.receipt.consignment.commodity === p.commodity)
        .map((l) => l.outlet.locationId)
        .filter((id) => !affected.has(id)),
    );

    const lots = new Set<string>(notice.implicatedLots);
    for (const h of p.harvests) lots.add(h.code);
    for (const b of affectedBatches(p)) {
      lots.add(batchCode(flow, b));
      lots.add(wmsVendorLot(batchCode(flow, b)));
    }
    for (const c of affectedConsignments(flow, p)) {
      if (c.directLot) lots.add(c.directLot);
      if (c.receipt) lots.add(c.receipt.lpn);
    }

    byNotice[p.noticeId] = {
      affectedLocations: [...affected].sort(),
      unaffectedLocations: [...unaffected].sort(),
      ambiguousLinks,
      commodity: p.commodity,
      implicatedLots: notice.implicatedLots,
      affectedLots: [...lots].sort(),
      window: { from: isoDay(flow, from), to: isoDay(flow, to) },
    };
  }
  return { seed, byNotice, anomalies };
}
