import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import {
  ANOMALY_KINDS, COMMODITY_IDS, TABLES, TABLE_NAMES, canonicalLot, charDistance,
  exportDuckDb, exportFiles, generateWorld, renderBolPng, type World,
} from "../src/index.ts";
import { referenceTrace } from "./reference-tracer.ts";

const SPEC = { seed: 7, days: 60, startDate: "2026-08-20" };
const hash = (w: World) => createHash("sha256").update(JSON.stringify(w)).digest("hex");
const str = (v: unknown) => (v == null ? "" : String(v));

const world = generateWorld(SPEC);
const t = world.tables;

describe("determinism", () => {
  it("same seed gives an identical world, a different seed a different one", () => {
    expect(hash(generateWorld(SPEC))).toBe(hash(world));
    expect(hash(generateWorld({ ...SPEC, seed: 8 }))).not.toBe(hash(world));
  });
});

describe("shape", () => {
  it("has every table, each row with exactly the schema columns and a unique primary key", () => {
    const problems: string[] = [];
    for (const name of TABLE_NAMES) {
      const rows = t[name];
      expect(rows.length, name).toBeGreaterThan(0);
      const cols = TABLES[name].columns.map((c) => c.name).join(",");
      const pks = new Set<string>();
      for (const row of rows) {
        if (Object.keys(row).join(",") !== cols) problems.push(`${name}: columns ${Object.keys(row).join(",")}`);
        const pk = row[TABLES[name].pk];
        if (pk === null || pk === "") problems.push(`${name}: empty pk`);
        pks.add(str(pk));
        for (const c of TABLES[name].columns) {
          const val = row[c.name];
          const want = c.type === "INTEGER" ? "number" : "string";
          if (val !== null && typeof val !== want) problems.push(`${name}.${c.name}: ${typeof val}`);
        }
      }
      if (pks.size !== rows.length) problems.push(`${name}: duplicate primary keys`);
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("covers 10 FTL commodities, 4 growers with 2-4 fields, 4 chains with >=30 stores, 3 food-service accounts, 2 carriers", () => {
    const commodities = new Set(t["wms.lpn"].map((r) => str(r.commodity)));
    expect([...commodities].sort()).toEqual([...COMMODITY_IDS].sort());

    const fieldsByFarm = new Map<string, Set<string>>();
    for (const r of t["grower.harvest"]) {
      const farm = str(r.farm_id);
      if (!fieldsByFarm.has(farm)) fieldsByFarm.set(farm, new Set());
      fieldsByFarm.get(farm)!.add(str(r.field_id));
    }
    expect(fieldsByFarm.size).toBe(4);
    for (const fields of fieldsByFarm.values()) {
      expect(fields.size).toBeGreaterThanOrEqual(2);
      expect(fields.size).toBeLessThanOrEqual(4);
    }

    const stores = t["ref.locations"].filter((r) => r.kind === "store");
    expect(stores.length).toBeGreaterThanOrEqual(30);
    expect(new Set(stores.map((r) => r.chain_id)).size).toBe(4);
    expect(t["ref.locations"].filter((r) => r.kind === "food_service")).toHaveLength(3);
    expect(new Set(t["carrier.bol_index"].map((r) => r.carrier_id)).size).toBe(2);
    // Not every node handles every commodity: the packer only sees produce.
    expect(new Set(t["packer.receipts"].map((r) => str(r.commodity))).size).toBeLessThan(10);
  });

  it("follows the lot-code conventions of each system", () => {
    for (const r of t["grower.harvest"]) expect(str(r.harvest_lot)).toMatch(/^GR\d{2}-\d{5}-F\d$/);
    for (const r of t["packer.repacks"]) expect(str(r.output_lot)).toMatch(/^PK\d{9}$/);
    const packerVendorLots = t["wms.lpn"].filter((r) => str(r.vendor_lot).startsWith("PK"));
    expect(packerVendorLots.length).toBeGreaterThan(0);
    for (const r of packerVendorLots) expect(str(r.vendor_lot)).toMatch(/^PK-\d{6}-\d{3}$/);
    for (const r of t["retail.receipts"]) expect(str(r.supplier_ref_lot)).toMatch(/^[A-Za-z]{3}:[A-Za-z0-9]+$/);
    expect(t["retail.receipts"].some((r) => /^[a-z]{3}:/.test(str(r.supplier_ref_lot)))).toBe(true);
  });

  it("has at least one commingled repack (two input lots, one output lot) per packer commodity", () => {
    const commodityOfInput = new Map(t["packer.receipts"].map((r) => [str(r.supplier_lot), str(r.commodity)]));
    const inputsByOutput = new Map<string, string[]>();
    for (const r of t["packer.repacks"]) {
      const out = str(r.output_lot);
      inputsByOutput.set(out, [...(inputsByOutput.get(out) ?? []), str(r.input_lot)]);
    }
    const commingled = new Set<string>();
    for (const inputs of inputsByOutput.values()) {
      if (inputs.length >= 2) commingled.add(commodityOfInput.get(inputs[0]!)!);
    }
    for (const c of new Set(commodityOfInput.values())) expect(commingled.has(c), c).toBe(true);
  });

  it("ships at least 6 notices plus one for a product the network never handled", () => {
    expect(world.notices.length).toBeGreaterThanOrEqual(7);
    const keyed = Object.keys(world.key.byNotice);
    expect(keyed.sort()).toEqual(world.notices.map((n) => n.noticeId).sort());
    const withAffected = world.notices.filter((n) => world.key.byNotice[n.noticeId]!.affectedLocations.length > 0);
    expect(withAffected.length).toBeGreaterThanOrEqual(6);
    const unhandled = world.notices.filter((n) => n.commodity === null);
    expect(unhandled).toHaveLength(1);
    expect(world.key.byNotice[unhandled[0]!.noticeId]!.affectedLocations).toEqual([]);
    for (const n of world.notices) {
      expect(n.text.length).toBeGreaterThan(200);
      expect(n.fields.recall_number).toMatch(/^F-\d{4}-2026$/);
      expect(n.fields.classification).toMatch(/^Class I{1,3}$/);
    }
    // Some notices name lot codes, some only a harvest date range from a farm.
    expect(world.notices.some((n) => /harvested between/i.test(n.text))).toBe(true);
    expect(world.notices.some((n) => /\bPK\d{9}\b/.test(n.text))).toBe(true);
  });
});

describe("planted anomalies", () => {
  const anomalies = world.key.anomalies;
  const byKind = (k: string) => anomalies.filter((a) => a.kind === k);
  const shipByBol = new Map(t["packer.shipments"].map((r) => [str(r.bol_no), r]));

  it("plants every anomaly class and tags each one in the key", () => {
    for (const kind of ANOMALY_KINDS) expect(byKind(kind).length, kind).toBeGreaterThan(0);
    for (const a of anomalies) {
      expect(a.reason.length).toBeGreaterThan(20);
      expect(a.noticeIds.length).toBeGreaterThan(0);
      for (const id of a.noticeIds) {
        const nk = world.key.byNotice[id]!;
        const tagged = nk.ambiguousLinks.some((l) => l.reason.startsWith(`${a.kind}:`) && l.from === a.from && l.to === a.to);
        expect(tagged, `${a.id} ${a.kind} in ${id}`).toBe(true);
        if (a.kind === "provable-clear") expect(nk.unaffectedLocations).toContain(a.from);
      }
      for (const rk of a.rowKeys) {
        const [table, pk] = [rk.slice(0, rk.indexOf(":")), rk.slice(rk.indexOf(":") + 1)];
        if (a.kind === "bol-only-receipt" && table === "wms.receiving") continue;
        const schema = TABLES[table as keyof typeof TABLES];
        expect(schema, rk).toBeDefined();
        expect(t[schema.name].some((r) => str(r[schema.pk]) === pk), rk).toBe(true);
      }
    }
  });

  it("bol-only receipt: the BOL and its LPN exist, the WMS receiving row does not", () => {
    const [a] = byKind("bol-only-receipt");
    const bolNo = a!.rowKeys.find((k) => k.startsWith("carrier.bol_index:"))!.split(":")[1]!;
    expect(t["carrier.bol_index"].some((r) => r.bol_no === bolNo)).toBe(true);
    expect(t["wms.receiving"].some((r) => r.bol_no === bolNo)).toBe(false);
    const lot = str(shipByBol.get(bolNo)!.output_lot);
    expect(t["wms.lpn"].some((r) => canonicalLot(str(r.vendor_lot)) === lot)).toBe(true);
    expect(world.bolScans.some((s) => s.truth.bolNo === bolNo && s.truth.receivedDate !== null)).toBe(true);
  });

  it("quantity mismatch and date-order violation are each exactly one packer→WMS pair", () => {
    const pairs = t["wms.receiving"].filter((r) => shipByBol.has(str(r.bol_no)));
    const qty = pairs.filter((r) => r.qty_cases !== shipByBol.get(str(r.bol_no))!.qty_cases);
    const early = pairs.filter((r) => str(r.received_at).slice(0, 10) < str(shipByBol.get(str(r.bol_no))!.ship_date));
    expect(qty).toHaveLength(1);
    expect(early).toHaveLength(1);
    expect(byKind("quantity-mismatch")[0]!.rowKeys).toContain(`wms.receiving:${qty[0]!.rcv_id}`);
    expect(byKind("date-order-violation")[0]!.rowKeys).toContain(`wms.receiving:${early[0]!.rcv_id}`);
  });

  it("injected instruction sits in one notes field and names a store that is actually affected", () => {
    const injected = t["wms.receiving"].filter((r) => /ignore (all )?prior instructions/i.test(str(r.notes)));
    expect(injected).toHaveLength(1);
    const [a] = byKind("prompt-injection");
    expect(a!.rowKeys).toContain(`wms.receiving:${injected[0]!.rcv_id}`);
    const store = a!.to;
    expect(str(injected[0]!.notes)).toContain(store.replace(/^ST0?/, ""));
    for (const id of a!.noticeIds) expect(world.key.byNotice[id]!.affectedLocations).toContain(store);
  });

  it("decoy lot differs from an implicated lot by one character and is not affected", () => {
    const [a] = byKind("decoy-lot");
    expect(charDistance(canonicalLot(a!.from), canonicalLot(a!.to))).toBe(1);
    for (const id of a!.noticeIds) {
      const nk = world.key.byNotice[id]!;
      expect(nk.affectedLots.map(canonicalLot)).toContain(canonicalLot(a!.to));
      expect(nk.affectedLots.map(canonicalLot)).not.toContain(canonicalLot(a!.from));
    }
    // The decoy actually reached customers, so a fuzzy matcher would raise a false PULL.
    const decoyLpns = new Set(t["wms.lpn"].filter((r) => canonicalLot(str(r.vendor_lot)) === canonicalLot(a!.from)).map((r) => r.internal_lpn));
    expect(t["wms.store_shipments"].some((r) => decoyLpns.has(r.internal_lpn))).toBe(true);
  });

  it("commingled anomaly joins an implicated input with a clean one", () => {
    const [a] = byKind("commingled-repack");
    const inputs = t["packer.repacks"].filter((r) => r.output_lot === a!.to).map((r) => str(r.input_lot));
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(inputs).toContain(a!.from);
    for (const id of a!.noticeIds) {
      const lots = world.key.byNotice[id]!.implicatedLots;
      expect(inputs.some((i) => !lots.includes(i))).toBe(true);
    }
  });
});

describe("ground truth", () => {
  const check = (w: World) => {
    for (const n of w.notices) {
      const nk = w.key.byNotice[n.noticeId]!;
      expect(nk.implicatedLots).toEqual(n.implicatedLots);
      const ref = referenceTrace(w.tables, n.implicatedLots, n.commodity);
      expect(nk.affectedLocations, `${n.noticeId} affected`).toEqual(ref.affected);
      expect(nk.unaffectedLocations, `${n.noticeId} unaffected`).toEqual(ref.unaffected);
      expect(nk.window, `${n.noticeId} window`).toEqual(ref.window);
      for (const loc of nk.unaffectedLocations) expect(nk.affectedLocations).not.toContain(loc);
    }
  };

  it("the key matches an exact-identity walk of the tables (seed 7)", () => check(world));

  it("holds for the eval seeds too, with every anomaly class planted", () => {
    // 11-13 are the eval seeds; 5 and 15 once had no clean romaine on hand during the exposure window.
    for (const seed of [5, 11, 12, 13, 15, 101]) {
      const w = generateWorld({ ...SPEC, seed });
      check(w);
      for (const kind of ANOMALY_KINDS) expect(w.key.anomalies.some((a) => a.kind === kind), `seed ${seed} ${kind}`).toBe(true);
      expect(w.notices.filter((n) => w.key.byNotice[n.noticeId]!.affectedLocations.length > 0).length).toBeGreaterThanOrEqual(6);
    }
  });

  it("the store named by the injected note is affected and the planted clear store is not", () => {
    const inj = world.key.anomalies.find((a) => a.kind === "prompt-injection")!;
    const clear = world.key.anomalies.find((a) => a.kind === "provable-clear")!;
    const nk = world.key.byNotice[clear.noticeIds[0]!]!;
    expect(nk.affectedLocations).toContain(inj.to);
    expect(nk.affectedLocations).not.toContain(clear.from);
    expect(nk.unaffectedLocations).toContain(clear.from);
  });
});

describe("bill-of-lading scans", () => {
  it("has one scan per indexed BOL, each pointing at a real row", () => {
    expect(world.bolScans).toHaveLength(t["carrier.bol_index"].length);
    const scanKeys = new Set(t["carrier.bol_index"].map((r) => str(r.scan_key)));
    for (const s of world.bolScans) {
      expect(scanKeys.has(s.key)).toBe(true);
      const [table, pk] = [s.truthRowKey.slice(0, s.truthRowKey.indexOf(":")), s.truthRowKey.slice(s.truthRowKey.indexOf(":") + 1)];
      const schema = TABLES[table as keyof typeof TABLES];
      expect(t[schema.name].some((r) => str(r[schema.pk]) === pk), s.truthRowKey).toBe(true);
      expect(s.svg).toContain(s.truth.bolNo);
      expect(s.svg).toContain(s.truth.lot);
    }
  });

  it("renders every kind of scan to PNG", () => {
    const bolOnly = world.key.anomalies.find((a) => a.kind === "bol-only-receipt")!;
    const bolOnlyNo = bolOnly.rowKeys.find((k) => k.startsWith("carrier.bol_index:"))!.split(":")[1];
    const samples = [
      world.bolScans.find((s) => s.truthRowKey.startsWith("packer.shipments:") && s.truth.consignee.startsWith("Northgate")),
      world.bolScans.find((s) => s.truth.consignee.startsWith("Bayline")),
      world.bolScans.find((s) => s.truthRowKey.startsWith("wms.receiving:")),
      world.bolScans.find((s) => s.truth.bolNo === bolOnlyNo),
    ];
    for (const scan of samples) {
      expect(scan).toBeDefined();
      const png = renderBolPng(scan!.svg);
      expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(png.length).toBeGreaterThan(5_000);
    }
  });
});

describe("exporters", () => {
  it("DuckDB snapshot has the same schemas, tables and row counts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "world-db-"));
    const dbPath = path.join(dir, "world.duckdb");
    await exportDuckDb(world, dbPath);
    const db = await DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" });
    const conn = await db.connect();
    try {
      const shipments = await conn.runAndReadAll("SELECT COUNT(*) AS n FROM packer.shipments");
      expect(Number(shipments.getRowObjects()[0]!.n)).toBe(t["packer.shipments"].length);
      for (const name of TABLE_NAMES) {
        const r = await conn.runAndReadAll(`SELECT COUNT(*) AS n FROM ${name}`);
        expect(Number(r.getRowObjects()[0]!.n), name).toBe(t[name].length);
      }
      // The answer key never goes into the snapshot the agents read.
      const tables = await conn.runAndReadAll("SELECT table_schema || '.' || table_name AS t FROM information_schema.tables");
      expect(tables.getRowObjects().map((r) => String(r.t)).sort()).toEqual([...TABLE_NAMES].sort());
      const drift = await conn.runAndReadAll("SELECT COUNT(*) AS n FROM wms.lpn WHERE vendor_lot LIKE 'PK-%'");
      expect(Number(drift.getRowObjects()[0]!.n)).toBeGreaterThan(0);
    } finally {
      conn.closeSync();
      db.closeSync();
    }
  });

  it("file export writes tables, scans and notices, with the key in a separate directory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "world-files-"));
    const out = path.join(dir, "generated");
    const keys = path.join(dir, "keys");
    const report = await exportFiles(world, out, { keysDir: keys, scanLimit: 3 });
    for (const name of TABLE_NAMES) {
      const csv = readFileSync(path.join(out, "tables", `${name}.csv`), "utf8").trimEnd().split("\n");
      expect(csv[0]).toBe(TABLES[name].columns.map((c) => c.name).join(","));
      expect(csv.length - 1, name).toBe(t[name].length);
      const jsonl = readFileSync(path.join(out, "tables", `${name}.jsonl`), "utf8").trimEnd().split("\n");
      expect(jsonl.length).toBe(t[name].length);
    }
    expect(readdirSync(path.join(out, "bol")).filter((f) => f.endsWith(".png"))).toHaveLength(3);
    const notices = JSON.parse(readFileSync(path.join(out, "notices", "notices.json"), "utf8"));
    expect(notices).toHaveLength(world.notices.length);
    for (const n of notices) expect(n).not.toHaveProperty("implicatedLots");
    expect(existsSync(path.join(keys, "seed-7.json"))).toBe(true);
    expect(readdirSync(out, { recursive: true }).some((f) => String(f).includes("seed-7"))).toBe(false);
    expect(report.keyPath).toBe(path.join(keys, "seed-7.json"));
  });
});
