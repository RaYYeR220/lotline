import type { TraceLog } from "@lotline/core";
import { ResponseCache, cacheKey } from "./cache.ts";
import { ocrKey } from "./ocr.ts";
import { short } from "./nightshift.ts";
import { tally } from "./panel.ts";
import { parseWith } from "./parse.ts";
import type { ChatReq, ChatRes, ModelGateway, OcrRes, PanelReq, PanelRes, PanelVote } from "./types.ts";

/**
 * Sample mode: no network. Answers come from responses recorded on live runs; when a prompt was never
 * recorded, the caller's deterministic rule answers instead and the trace says so.
 */
export class SampleGateway implements ModelGateway {
  readonly mode = "sample" as const;
  private readonly cache: ResponseCache;
  private calls = 0;

  constructor(private readonly trace: TraceLog, opts: { cacheFile?: string } = {}) {
    this.cache = new ResponseCache(opts.cacheFile ?? "data/sample/model-cache.jsonl");
  }

  callCount(): number {
    return this.calls;
  }

  async chat<T>(req: ChatReq<T>): Promise<ChatRes<T>> {
    this.calls++;
    const hit = this.cache.get(cacheKey(req.lane, req.system, req.user));
    if (hit) {
      const parsed = parseWith(req.schema, hit.raw);
      if (parsed.ok) {
        const model = `cache/${hit.model}`;
        this.trace.emit({
          agent_name: req.agent, action: "nightshift.chat", input_summary: short(req.purpose),
          output_summary: short(JSON.stringify(parsed.value)), target_agent: req.targetAgent ?? null,
          model, status: "success", detail: { lane: req.lane, receipt_id: hit.receiptId, replayed: true },
        });
        return { model, lane: req.lane, json: parsed.value, raw: hit.raw, latencyMs: 0, source: "cache", receiptId: hit.receiptId };
      }
    }
    const value = req.ruleFallback();
    this.trace.emit({
      agent_name: req.agent, action: "rules.fallback", input_summary: short(req.purpose),
      output_summary: short(JSON.stringify(value)), target_agent: req.targetAgent ?? null,
      model: "rules/fallback", status: "success", detail: { lane: req.lane },
    });
    return { model: "rules/fallback", lane: req.lane, json: value, raw: "", latencyMs: 0, source: "rules" };
  }

  async ocr(req: { agent: string; purpose: string; imagePng: Uint8Array }): Promise<OcrRes | null> {
    const hit = this.cache.get(ocrKey(req.imagePng));
    if (!hit) {
      this.trace.emit({ agent_name: req.agent, action: "nightshift.ocr", input_summary: short(req.purpose), output_summary: "page not read on a recorded run", model: "rules/fallback", status: "skipped" });
      return null;
    }
    this.calls++;
    const page = JSON.parse(hit.raw) as { text: string; lines: { text: string; confidence: number }[] };
    this.trace.emit({ agent_name: req.agent, action: "nightshift.ocr", input_summary: short(req.purpose), output_summary: `${page.lines.length} lines (recorded)`, model: `cache/${hit.model}`, status: "success", detail: { replayed: true } });
    return { ...page, model: `cache/${hit.model}`, source: "cache" };
  }

  async panel<T extends { answer: string; why: string }>(req: PanelReq<T>): Promise<PanelRes> {
    const votes: PanelVote[] = [];
    for (const lane of req.lanes) {
      const r = await this.chat({ agent: req.agent, lane, purpose: `${req.purpose} [panel:${lane}]`, system: req.system, user: req.user, schema: req.schema, ruleFallback: req.ruleVote, targetAgent: req.targetAgent });
      votes.push({ lane, model: r.model, answer: r.json.answer, why: r.json.why, receiptId: r.receiptId, source: r.source });
    }
    const result = tally(votes);
    this.trace.emit({
      agent_name: req.agent, action: "panel.tally", input_summary: short(req.purpose),
      output_summary: result.outcome === "accepted" ? `${result.winner} (${votes.length} votes)` : `undecided: ${votes.map((v) => v.answer).join(" / ")}`,
      target_agent: req.targetAgent ?? null, model: votes.map((v) => v.model).join(","), confidence: result.agreement,
      status: result.outcome === "accepted" ? "success" : "escalated", detail: { votes },
    });
    return result;
  }
}
