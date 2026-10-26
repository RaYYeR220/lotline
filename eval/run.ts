// Graded evaluation against a hidden answer key.
//
//   npx tsx eval/run.ts                      sample mode, seed 7, all notices
//   LOTLINE_DATA=sample npx tsx eval/run.ts  live models through Nightshift over the same snapshot
//
// The agents never see the key: it is read here, after each run, only to score the result.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { TraceLog, loadConfig } from "@lotline/core";
import { createRunDeps, runRecall } from "@lotline/agents";
import { scoreRun, type NoticeScore } from "./score.ts";

const seed = Number(process.argv.find((a) => a.startsWith("--seed="))?.split("=")[1] ?? 7);
const only = process.argv.find((a) => a.startsWith("--notices="))?.split("=")[1]?.split(",");
const key = JSON.parse(readFileSync(`eval/keys/seed-${seed}.json`, "utf8"));
const notices: { noticeId: string; text: string }[] = JSON.parse(readFileSync("data/sample/notices.json", "utf8"));
const cfg = loadConfig();
const models = cfg.sampleMode ? "recorded answers (sample mode)" : "live through Nightshift";

const rows: (NoticeScore & { modelCalls: number; fallbacks: number; ms: number; panels: number; retries: number; refused: number; models: string[] })[] = [];
for (const n of notices.filter((x) => !only || only.includes(x.noticeId))) {
  const trace = new TraceLog(`eval-s${seed}-${n.noticeId}-${Date.now()}`, { dir: "logs", stdout: false });
  const result = await runRecall({ notice: n.text }, createRunDeps(cfg, trace, { stateDir: "data/generated/eval-state" }));
  const events = trace.events();
  const score = scoreRun(n.noticeId, result, key.byNotice[n.noticeId]);
  const used = events.filter((e) => e.action === "nightshift.chat" || e.action === "rules.fallback").map((e) => e.model ?? "");
  rows.push({
    ...score,
    modelCalls: used.length,
    fallbacks: used.filter((m) => m === "rules/fallback").length,
    ms: result.stats.ms,
    panels: result.stats.races,
    retries: result.stats.retries,
    refused: events.filter((e) => e.action === "contract.refused").length,
    models: [...new Set(used.map((m) => m.replace(/^cache\//, "")).filter((m) => m && m !== "rules/fallback"))],
  });
  console.error(`${n.noticeId}: caught ${score.caught}/${score.affected}, missed ${score.missed.length}, false CLEAR ${score.falseClear.length}, provable clears ${score.provableClears}, ${(result.stats.ms / 1000).toFixed(1)} s`);
}

const total = (k: keyof NoticeScore) => rows.reduce((s, r) => s + (Array.isArray(r[k]) ? (r[k] as unknown[]).length : Number(r[k])), 0);
const summary = {
  seed, models, runs: rows.length,
  affected: total("affected"), caught: total("caught"), missed: total("missed"), falseClear: total("falseClear"),
  pulledUnaffected: total("pulledUnaffected"), provableClears: total("provableClears"),
  provableClearTargets: Object.values(key.byNotice as Record<string, { unaffectedLocations: string[] }>).filter((_, i) => !only || only.includes(Object.keys(key.byNotice)[i])).reduce((s, v) => s + v.unaffectedLocations.length, 0),
};
mkdirSync("eval/results", { recursive: true });
const tag = cfg.sampleMode ? "sample" : "live";
writeFileSync(`eval/results/seed-${seed}-${tag}.json`, JSON.stringify({ summary, rows }, null, 2));
const md = [
  `# Eval: seed ${seed}, ${models}`,
  "",
  `Affected locations caught **${summary.caught}/${summary.affected}** · missed **${summary.missed}** · CLEAR on an affected location **${summary.falseClear}** · PULL on an unaffected location **${summary.pulledUnaffected}** · provable clears found **${summary.provableClears}/${summary.provableClearTargets}**`,
  "",
  "| notice | affected | caught | missed | false CLEAR | provable clears | holds | panels | retries | refused contracts | model calls (rule fallbacks) | time |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.noticeId} | ${r.affected} | ${r.caught} | ${r.missed.length} | ${r.falseClear.length} | ${r.provableClears} | ${r.holds} | ${r.panels} | ${r.retries} | ${r.refused} | ${r.modelCalls} (${r.fallbacks}) | ${(r.ms / 1000).toFixed(1)} s |`),
  "",
  `Models that answered: ${[...new Set(rows.flatMap((r) => r.models))].join(", ") || "none (rule lanes only)"}`,
].join("\n");
writeFileSync(`eval/results/seed-${seed}-${tag}.md`, md + "\n");
console.log(md);
