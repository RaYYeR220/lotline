import { createHash } from "node:crypto";
import type { Evidence, LinkKind, RecallScope, TraceLink } from "@lotline/core";
import type { Row } from "@lotline/adapters";
import type { AgentContext } from "./context.ts";
import { canonicalLot, matchLot } from "./lotcodes.ts";
import type { SourceMap } from "./mapper.ts";
import { addDays, dayDiff, evidence, inList, q, spellings } from "./sql.ts";

/** What the critic needs to judge a link without re-reading rows. */
export interface LinkCheck {
  lot: "exact" | "truncated" | "near" | "none" | "n/a";
  bol: boolean | null;
  qtyDelta: number | null;
  dayDelta: number | null;
  firstParty: boolean;
  missing?: "receiving-record" | "repack-receipt";
  bolNo?: string;
}

export interface TraceGraph {
  implicated: string[];
  links: TraceLink[];
  checks: Map<string, LinkCheck>;
  /** Shipments to firms outside our network (we notify them; we do not act for them). */
  external: { firm: string; lot: string; evidence: Evidence }[];
  /** Free-text partner fields that tried to instruct the system. */
  flaggedNotes: { rowKey: string; text: string; signals: string[]; lpn?: string }[];
  commodity: string;
}

const AGENT = "TracerAgent";
export const DISTRIBUTOR_ID = process.env.LOTLINE_DISTRIBUTOR_ID ?? "NGP";

const linkId = (kind: LinkKind, from: string, to: string, key: string) =>
  `LK-${createHash("sha256").update(`${kind}|${from}|${to}|${key}`).digest("hex").slice(0, 10)}`;

function link(kind: LinkKind, from: string, to: string, at: string, ev: Evidence[], quantity?: number): TraceLink {
  return { id: linkId(kind, from, to, ev.map((e) => e.rowKey).join(",")), kind, from, to, at: at.slice(0, 10), quantity, evidence: ev, status: "proposed", confidence: 0, notes: [] };
}

const qty = (r: Row, col: string | null) => (col && r[col] != null ? Number(r[col]) : undefined);

/** Turns the recall scope into concrete lot codes found in partner records. */
export async function resolveImplicated(ctx: AgentContext, scope: RecallScope, map: SourceMap): Promise<{ lots: string[]; commodity: string }> {
  const qctx = { agent: AGENT, purpose: "resolve implicated lots", targetAgent: "EvidenceCritic" };
  const found = new Set<string>();
  let commodity = scope.commodity;

  if (scope.lotCodes.length) {
    const all = scope.lotCodes.flatMap(spellings);
    const h = map["grower.harvest"];
    const harvest = await ctx.data.query(`SELECT ${h.lot}, commodity FROM grower.harvest WHERE ${h.lot} IN ${inList(all)}`, { ...qctx, purpose: "lot codes in grower harvest records" });
    for (const r of harvest.rows) { found.add(canonicalLot(String(r[h.lot!]))); commodity = String(r.commodity ?? commodity); }
    const s = map["packer.shipments"];
    const packed = await ctx.data.query(`SELECT DISTINCT ${s.lot} FROM packer.shipments WHERE ${s.lot} IN ${inList(all)}`, { ...qctx, purpose: "lot codes in packer records" });
    for (const r of packed.rows) found.add(canonicalLot(String(r[s.lot!])));
    const l = map["wms.lpn"];
    const direct = await ctx.data.query(`SELECT ${l.lot}, commodity FROM wms.lpn WHERE ${l.lot} IN ${inList(all)}`, { ...qctx, purpose: "lot codes received directly from manufacturers" });
    for (const r of direct.rows) { found.add(canonicalLot(String(r[l.lot!]))); commodity = String(r.commodity ?? commodity); }
  } else if (scope.dateFrom && scope.dateTo) {
    const h = map["grower.harvest"];
    let farmFilter = "";
    if (scope.firm) {
      const firms = await ctx.data.query(`SELECT firm_id, name FROM ref.firms WHERE role = 'grower'`, { ...qctx, purpose: "growers named in the notice" });
      const hit = firms.rows.filter((f) => scope.firm!.toLowerCase().includes(String(f.name).toLowerCase()) || String(f.name).toLowerCase().includes(scope.firm!.toLowerCase().split(",")[0].trim()));
      if (hit.length) farmFilter = ` AND farm_id IN ${inList(hit.map((f) => String(f.firm_id)))}`;
    }
    const rows = await ctx.data.query(
      `SELECT ${h.lot}, farm_id, ${h.date} FROM grower.harvest WHERE commodity = ${q(commodity)} AND ${h.date} >= ${q(scope.dateFrom)} AND ${h.date} <= ${q(scope.dateTo)}${farmFilter}`,
      { ...qctx, purpose: "harvest lots inside the notice's date window" },
    );
    for (const r of rows.rows) found.add(canonicalLot(String(r[h.lot!])));
  }

  ctx.trace.emit({
    agent_name: AGENT, action: "lots.resolved", input_summary: scope.lotCodes.length ? `${scope.lotCodes.length} codes from the notice` : `window ${scope.dateFrom}..${scope.dateTo}`,
    output_summary: found.size ? `${found.size} implicated lots: ${[...found].slice(0, 6).join(", ")}` : "no implicated lots found in partner records",
    target_agent: "TracerAgent", status: found.size ? "success" : "escalated", detail: { lots: [...found], commodity },
  });
  return { lots: [...found], commodity };
}

/** TracerAgent: walks implicated lots forward through every partner system, recording each hop as a link with its rows. */
export async function traceForward(ctx: AgentContext, implicated: string[], commodity: string, map: SourceMap): Promise<TraceGraph> {
  const graph: TraceGraph = { implicated, links: [], checks: new Map(), external: [], flaggedNotes: [], commodity };
  const add = (l: TraceLink, c: LinkCheck) => {
    if (graph.checks.has(l.id)) return;
    graph.links.push(l);
    graph.checks.set(l.id, c);
  };
  const qctx = (purpose: string) => ({ agent: AGENT, purpose, targetAgent: "EvidenceCritic" });

  // 1. Transformation: grower lots repacked into packer lots (one implicated input taints the whole output).
  const rp = map["packer.repacks"];
  const repacks = await ctx.data.query(`SELECT * FROM packer.repacks WHERE input_lot IN ${inList(implicated.flatMap(spellings))}`, qctx("repacks that consumed implicated lots"));
  const receipts = repacks.rows.length
    ? await ctx.data.query(`SELECT * FROM packer.receipts WHERE supplier_lot IN ${inList(repacks.rows.map((r) => String(r.input_lot)))}`, qctx("packer receipts of those input lots"))
    : null;
  const packerLots = new Set(implicated.filter((l) => l.startsWith("PK")));
  for (const r of repacks.rows) {
    const out = canonicalLot(String(r[rp.lot!]));
    const input = canonicalLot(String(r.input_lot));
    packerLots.add(out);
    const rec = receipts?.rows.find((x) => canonicalLot(String(x.supplier_lot)) === input);
    const ev = [evidence(repacks, "packer.repacks", rp.pk, r), ...(rec && receipts ? [evidence(receipts, "packer.receipts", "receipt_id", rec)] : [])];
    add(link("derived-from", `lot:${out}`, `lot:${input}`, String(r[rp.date!]), ev, qty(r, rp.qty)), { lot: "exact", bol: null, qtyDelta: null, dayDelta: null, firstParty: false, missing: rec ? undefined : "repack-receipt" });
  }

  // 2. Shipping/receiving: packer lots to the distributor (by bill of lading and lot), or to outside firms.
  const lpnByLot = new Map<string, Set<string>>();
  if (packerLots.size) {
    const sp = map["packer.shipments"];
    const ships = await ctx.data.query(`SELECT * FROM packer.shipments WHERE ${sp.lot} IN ${inList([...packerLots].flatMap(spellings))}`, qctx("packer shipments of affected lots"));
    const toUs = ships.rows.filter((r) => String(r.customer_id) === DISTRIBUTOR_ID);
    for (const r of ships.rows.filter((x) => String(x.customer_id) !== DISTRIBUTOR_ID)) {
      graph.external.push({ firm: String(r.customer_id), lot: canonicalLot(String(r[sp.lot!])), evidence: evidence(ships, "packer.shipments", sp.pk, r) });
    }
    const wr = map["wms.receiving"];
    const rcv = toUs.length
      ? await ctx.data.query(
          `SELECT * FROM wms.receiving WHERE bol_no IN ${inList(toUs.map((r) => String(r.bol_no)))} OR ${wr.lot} IN ${inList([...packerLots].flatMap(spellings))}`,
          qctx("distributor receiving records for those loads"),
        )
      : null;
    const wl = map["wms.lpn"];
    const lpns = await ctx.data.query(`SELECT * FROM wms.lpn WHERE ${wl.lot} IN ${inList([...packerLots].flatMap(spellings))}`, qctx("distributor pallets carrying affected lots"));
    const usedLpn = new Set<string>();
    for (const s of toUs) {
      const lot = canonicalLot(String(s[sp.lot!]));
      const match = rcv?.rows.find((r) => String(r.bol_no) === String(s.bol_no) && matchLot(lot, String(r[wr.lot!])).kind === "exact")
        ?? rcv?.rows.find((r) => String(r.bol_no) === String(s.bol_no))
        ?? rcv?.rows.find((r) => matchLot(lot, String(r[wr.lot!])).kind === "exact" && Math.abs(dayDiff(String(s.ship_date), String(r[wr.date!]))) <= 3 && !usedLpn.has(String(r.internal_lpn)));
      if (match && rcv) {
        const lpn = String(match.internal_lpn);
        usedLpn.add(lpn);
        (lpnByLot.get(lot) ?? lpnByLot.set(lot, new Set()).get(lot)!).add(lpn);
        const shipQty = qty(s, sp.qty) ?? 0;
        const rcvQty = qty(match, wr.qty) ?? 0;
        add(link("received-as", `lot:${lot}`, `lpn:${lpn}`, String(match[wr.date!]), [evidence(ships, "packer.shipments", sp.pk, s), evidence(rcv, "wms.receiving", wr.pk, match)], rcvQty), {
          lot: matchLot(lot, String(match[wr.lot!])).kind, bol: String(match.bol_no) === String(s.bol_no), qtyDelta: rcvQty - shipQty,
          dayDelta: dayDiff(String(s.ship_date), String(match[wr.date!])), firstParty: false, bolNo: String(s.bol_no),
        });
        const note = String(match.notes ?? "");
        const scan = note ? ctx.gate.scan(note) : null;
        if (scan?.flagged) graph.flaggedNotes.push({ rowKey: `wms.receiving:${match[wr.pk]}`, text: note, signals: scan.signals, lpn });
      } else {
        // No receiving row for this load: a pallet record may still carry the lot; the bill of lading must prove receipt.
        const pallet = lpns.rows.find((r) => matchLot(lot, String(r[wl.lot!])).kind === "exact" && !usedLpn.has(String(r.internal_lpn)));
        if (pallet) {
          const lpn = String(pallet.internal_lpn);
          usedLpn.add(lpn);
          (lpnByLot.get(lot) ?? lpnByLot.set(lot, new Set()).get(lot)!).add(lpn);
          add(link("received-as", `lot:${lot}`, `lpn:${lpn}`, String(s.ship_date), [evidence(ships, "packer.shipments", sp.pk, s), evidence(lpns, "wms.lpn", wl.pk, pallet)], qty(s, sp.qty)), {
            lot: "exact", bol: null, qtyDelta: null, dayDelta: null, firstParty: false, missing: "receiving-record", bolNo: String(s.bol_no),
          });
        }
      }
    }
  }

  // 3. Lots received straight from manufacturers (no packer in between).
  const direct = implicated.filter((l) => !l.startsWith("PK") && !l.startsWith("GR"));
  if (direct.length) {
    const wl = map["wms.lpn"];
    const pallets = await ctx.data.query(`SELECT * FROM wms.lpn WHERE ${wl.lot} IN ${inList(direct.flatMap(spellings))}`, qctx("pallets of directly received lots"));
    const wr = map["wms.receiving"];
    const rcv = pallets.rows.length
      ? await ctx.data.query(`SELECT * FROM wms.receiving WHERE internal_lpn IN ${inList(pallets.rows.map((r) => String(r.internal_lpn)))}`, qctx("receiving records of those pallets"))
      : null;
    for (const p of pallets.rows) {
      const lot = canonicalLot(String(p[wl.lot!]));
      const lpn = String(p.internal_lpn);
      (lpnByLot.get(lot) ?? lpnByLot.set(lot, new Set()).get(lot)!).add(lpn);
      const r = rcv?.rows.find((x) => String(x.internal_lpn) === lpn);
      const ev = [evidence(pallets, "wms.lpn", wl.pk, p), ...(r && rcv ? [evidence(rcv, "wms.receiving", wr.pk, r)] : [])];
      add(link("received-as", `lot:${lot}`, `lpn:${lpn}`, String(r?.[wr.date!] ?? ""), ev, r ? qty(r, wr.qty) : undefined), {
        lot: r ? matchLot(lot, String(r[wr.lot!])).kind : "exact", bol: null, qtyDelta: 0, dayDelta: 0, firstParty: true, missing: r ? undefined : "receiving-record",
      });
    }
  }

  // 4. Distributor pallets to stores and food-service accounts, corroborated by the stores' own receiving.
  const allLpns = [...new Set([...lpnByLot.values()].flatMap((s) => [...s]))];
  if (allLpns.length) {
    const ss = map["wms.store_shipments"];
    const lines = await ctx.data.query(`SELECT * FROM wms.store_shipments WHERE ${ss.lot} IN ${inList(allLpns)}`, qctx("store deliveries from affected pallets"));
    const lotOfLpn = new Map<string, string>();
    for (const [lot, set] of lpnByLot) for (const l of set) lotOfLpn.set(l, lot);
    const stores = [...new Set(lines.rows.map((r) => String(r[ss.location!])))];
    const dates = lines.rows.map((r) => String(r[ss.date!]).slice(0, 10)).sort();
    const rr = map["retail.receipts"];
    const retail = stores.length
      ? await ctx.data.query(
          `SELECT * FROM retail.receipts WHERE store_id IN ${inList(stores)} AND ${rr.date} >= ${q(dates[0])} AND ${rr.date} <= ${q(addDays(dates.at(-1)!, 4))}`,
          qctx("stores' own receiving in the delivery window"),
        )
      : null;
    for (const r of lines.rows) {
      const lpn = String(r[ss.lot!]);
      const store = String(r[ss.location!]);
      const lot = lotOfLpn.get(lpn) ?? "";
      const corroborating = retail?.rows.find((x) => String(x.store_id) === store && ["exact", "truncated"].includes(matchLot(lot, String(x[rr.lot!])).kind) && dayDiff(String(r[ss.date!]), String(x[rr.date!])) >= 0 && dayDiff(String(r[ss.date!]), String(x[rr.date!])) <= 3);
      const ev = [evidence(lines, "wms.store_shipments", ss.pk, r), ...(corroborating && retail ? [evidence(retail, "retail.receipts", rr.pk, corroborating)] : [])];
      add(link("shipped-to", `lpn:${lpn}`, `loc:${store}`, String(r[ss.date!]), ev, qty(r, ss.qty)), {
        lot: corroborating ? matchLot(lot, String(corroborating[rr.lot!])).kind : "n/a", bol: null, qtyDelta: null, dayDelta: null, firstParty: true,
      });
    }
  }

  ctx.trace.emit({
    agent_name: AGENT, action: "trace.forward", input_summary: `${implicated.length} implicated lots`,
    output_summary: `${graph.links.length} links proposed (${allLpns.length} pallets, ${new Set(graph.links.filter((l) => l.kind === "shipped-to").map((l) => l.to)).size} locations); ${graph.external.length} shipments to outside firms`,
    target_agent: "EvidenceCritic", status: "success",
    detail: { lots: [...lpnByLot.keys()], pallets: allLpns, flagged_notes: graph.flaggedNotes.length },
  });
  return graph;
}

/** Narrower follow-up queries the critic can ask for when a link does not meet the proof bar. */
export async function corroborate(ctx: AgentContext, l: TraceLink, check: LinkCheck, attempt: number): Promise<{ evidence: Evidence[]; facts: string[] }> {
  const qctx = { agent: AGENT, purpose: `corroborate ${l.id}`, targetAgent: "EvidenceCritic" };
  const facts: string[] = [];
  const found: Evidence[] = [];
  if (check.bolNo) {
    const bol = await ctx.data.query(`SELECT * FROM carrier.bol_index WHERE bol_no = ${q(check.bolNo)}`, qctx);
    for (const r of bol.rows) {
      found.push(evidence(bol, "carrier.bol_index", "bol_no", r));
      facts.push(`carrier BOL ${r.bol_no}: shipped ${r.ship_date} from ${r.origin} to ${r.consignee}; scan ${r.scan_key}`);
    }
  }
  if (l.kind === "derived-from" && check.missing === "repack-receipt") {
    const input = l.to.replace(/^lot:/, "");
    const h = await ctx.data.query(`SELECT * FROM grower.harvest WHERE harvest_lot IN ${inList(spellings(input))}`, qctx);
    for (const r of h.rows) {
      found.push(evidence(h, "grower.harvest", "harvest_lot", r));
      facts.push(`grower harvest record ${r.harvest_lot} (${r.farm_name}, ${r.harvest_date}, ${r.qty_cases} cases)`);
    }
  }
  ctx.trace.emit({
    agent_name: AGENT, action: "corroborate", input_summary: `${l.kind} ${l.from} -> ${l.to}`,
    output_summary: found.length ? facts.join("; ").slice(0, 200) : "no further records",
    target_agent: "EvidenceCritic", retry_count: attempt, status: found.length ? "success" : "needs_revision",
  });
  return { evidence: found, facts };
}
