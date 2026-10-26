// Baseline: the same notice and the same partner records, answered by one large prompt to the same
// model family, with no agents, no critic and no rules. Scored with the same key.
//
//   npx tsx eval/baseline.ts [--notices=N1,N2]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { DuckDbSample, NightshiftGateway } from "@lotline/adapters";
import { TraceLog, loadConfig } from "@lotline/core";
import { nightshiftToken } from "@lotline/agents";
import { scoreRun } from "./score.ts";

try { process.loadEnvFile(".env"); } catch { /* environment only */ }

const only = process.argv.find((a) => a.startsWith("--notices="))?.split("=")[1]?.split(",");
const key = JSON.parse(readFileSync("eval/keys/seed-7.json", "utf8"));
const notices: { noticeId: string; text: string }[] = JSON.parse(readFileSync("data/sample/notices.json", "utf8"));
const cfg = loadConfig();
const Answer = z.object({ pull: z.array(z.string()), clear: z.array(z.string()) });

const csv = (rows: Record<string, string | null>[]) => (rows.length ? [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).map((v) => v ?? "").join(","))].join("\n") : "");

const rows: unknown[] = [];
for (const n of notices.filter((x) => !only || only.includes(x.noticeId))) {
  const trace = new TraceLog(`baseline-${n.noticeId}-${Date.now()}`, { dir: "logs", stdout: false });
  const data = new DuckDbSample("data/sample/world.duckdb", trace);
  const commodity = key.byNotice[n.noticeId].commodity as string;
  const q = (sql: string) => data.query(sql, { agent: "Baseline", purpose: "dump" }).then((r) => csv(r.rows));
  // Everything a person would export for this commodity, as plain tables.
  const dump = [
    ["grower.harvest", await q(`SELECT * FROM grower.harvest WHERE commodity = '${commodity}' ORDER BY harvest_lot`)],
    ["packer.repacks", await q(`SELECT r.* FROM packer.repacks r JOIN packer.receipts p ON r.input_lot = p.supplier_lot WHERE p.commodity = '${commodity}' ORDER BY repack_id`)],
    ["packer.shipments", await q(`SELECT s.* FROM packer.shipments s WHERE s.output_lot IN (SELECT r.output_lot FROM packer.repacks r JOIN packer.receipts p ON r.input_lot = p.supplier_lot WHERE p.commodity = '${commodity}') ORDER BY ship_id`)],
    ["wms.lpn", await q(`SELECT * FROM wms.lpn WHERE commodity = '${commodity}' ORDER BY internal_lpn`)],
    ["wms.receiving", await q(`SELECT r.* FROM wms.receiving r JOIN wms.lpn l ON r.internal_lpn = l.internal_lpn WHERE l.commodity = '${commodity}' ORDER BY rcv_id`)],
    ["wms.store_shipments", await q(`SELECT s.* FROM wms.store_shipments s JOIN wms.lpn l ON s.internal_lpn = l.internal_lpn WHERE l.commodity = '${commodity}' ORDER BY order_line_id`)],
    ["ref.locations", await q(`SELECT location_id, name FROM ref.locations ORDER BY location_id`)],
  ].map(([t, body]) => `## ${t}\n${body}`).join("\n\n");
  await data.close();

  const gw = new NightshiftGateway({ ...cfg, nightshift: { ...cfg.nightshift, token: nightshiftToken(cfg) } }, trace, { timeoutMs: 300_000 });
  const started = Date.now();
  const res = await gw.chat({
    agent: "Baseline", lane: "reason", purpose: "answer the recall in one prompt", maxTokens: 4000,
    system: "You are a food-safety analyst. Using only the records given, list every location_id that received affected product (pull) and every location_id that received this commodity in the same period but provably only unaffected lots (clear). Reply with one JSON object: {\"pull\":[...],\"clear\":[...]}.",
    user: `${n.text}\n\n${dump}`,
    schema: Answer, ruleFallback: () => ({ pull: [], clear: [] }),
  });
  const actions = [
    ...res.json.pull.map((l) => ({ locationId: l, kind: "PULL" as const })),
    ...res.json.clear.filter((l) => !res.json.pull.includes(l)).map((l) => ({ locationId: l, kind: "CLEAR" as const })),
  ];
  const score = scoreRun(n.noticeId, { actions: actions as never }, key.byNotice[n.noticeId]);
  rows.push({ ...score, model: res.model, promptChars: dump.length + n.text.length, ms: Date.now() - started });
  console.error(`${n.noticeId}: caught ${score.caught}/${score.affected}, missed ${score.missed.length}, false CLEAR ${score.falseClear.length}, PULL on unaffected ${score.pulledUnaffected.length} (${res.model})`);
}
mkdirSync("eval/results", { recursive: true });
writeFileSync("eval/results/baseline-seed-7.json", JSON.stringify(rows, null, 2));
