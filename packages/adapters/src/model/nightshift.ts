import type { LotlineConfig, TraceLog } from "@lotline/core";
import { ResponseCache, cacheKey } from "./cache.ts";
import { NightshiftOcr, ocrKey } from "./ocr.ts";
import { tally } from "./panel.ts";
import { parseWith } from "./parse.ts";
import type { ChatReq, ChatRes, Lane, ModelGateway, OcrRes, PanelReq, PanelRes, PanelVote } from "./types.ts";

interface Options {
  fetchImpl?: typeof fetch;
  cacheFile?: string;
  /** Append live answers to the cache so sample mode can replay them. */
  record?: boolean;
  /** Run panel votes concurrently (default) or one after another. */
  parallel?: boolean;
  timeoutMs?: number;
}

interface Completion {
  raw: string;
  model: string;
  receiptId?: string;
  latencyMs: number;
}

export const short = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/\s+/g, " ");

/** Every model call in Lotline goes through Meterless Nightshift's OpenAI-compatible endpoint. */
export class NightshiftGateway implements ModelGateway {
  readonly mode = "live" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: ResponseCache;
  private calls = 0;
  private reader?: NightshiftOcr;

  constructor(
    private readonly cfg: LotlineConfig,
    private readonly trace: TraceLog,
    private readonly opts: Options = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cache = new ResponseCache(opts.cacheFile ?? "data/sample/model-cache.jsonl");
  }

  callCount(): number {
    return this.calls;
  }

  async chat<T>(req: ChatReq<T>): Promise<ChatRes<T>> {
    const started = Date.now();
    let user = req.user;
    let model = this.cfg.lanes[req.lane];
    for (let attempt = 0; attempt < 2; attempt++) {
      let completion: Completion;
      try {
        completion = await this.complete(req, user, model);
      } catch (err) {
        // A provider that refuses a lane's model gets one retry on the reasoning lane's model.
        const reroute = attempt === 0 && model !== this.cfg.lanes.reason && !req.imagePng;
        this.trace.emit({
          agent_name: req.agent, action: "nightshift.chat", input_summary: short(req.purpose),
          output_summary: `request failed: ${short((err as Error).message)}${reroute ? `; retrying on ${this.cfg.lanes.reason}` : ""}`, model,
          retry_count: attempt, status: reroute ? "retry" : "error", detail: { lane: req.lane },
        });
        if (!reroute) break;
        model = this.cfg.lanes.reason;
        continue;
      }
      const parsed = parseWith(req.schema, completion.raw);
      if (parsed.ok) {
        if (this.opts.record) {
          this.cache.put({ key: cacheKey(req.lane, req.system, req.user), lane: req.lane, model: completion.model, raw: completion.raw, receiptId: completion.receiptId });
        }
        this.trace.emit({
          agent_name: req.agent, action: "nightshift.chat", input_summary: short(req.purpose),
          output_summary: short(JSON.stringify(parsed.value)), target_agent: req.targetAgent ?? null,
          model: completion.model, retry_count: attempt, status: "success",
          detail: { lane: req.lane, receipt_id: completion.receiptId, latency_ms: completion.latencyMs },
        });
        return { model: completion.model, lane: req.lane, json: parsed.value, raw: completion.raw, latencyMs: Date.now() - started, source: "nightshift", receiptId: completion.receiptId };
      }
      this.trace.emit({
        agent_name: req.agent, action: "nightshift.chat", input_summary: short(req.purpose),
        output_summary: `reply did not match the schema: ${short(parsed.error)}`, model: completion.model,
        retry_count: attempt, status: "needs_revision", detail: { lane: req.lane, receipt_id: completion.receiptId },
      });
      user = `${req.user}\n\nYour previous reply was not valid. Problem: ${parsed.error}. Reply with one JSON object only.`;
    }
    const value = req.ruleFallback();
    this.trace.emit({
      agent_name: req.agent, action: "rules.fallback", input_summary: short(req.purpose),
      output_summary: short(JSON.stringify(value)), target_agent: req.targetAgent ?? null,
      model: "rules/fallback", status: "success", detail: { lane: req.lane },
    });
    return { model: "rules/fallback", lane: req.lane, json: value, raw: "", latencyMs: Date.now() - started, source: "rules" };
  }

  async ocr(req: { agent: string; purpose: string; imagePng: Uint8Array }): Promise<OcrRes | null> {
    this.reader ??= new NightshiftOcr(this.cfg.nightshift.baseUrl, this.cfg.nightshift.token, this.fetchImpl);
    const started = Date.now();
    const page = await this.reader.page(req.imagePng).catch(() => null);
    if (!page) {
      this.trace.emit({ agent_name: req.agent, action: "nightshift.ocr", input_summary: short(req.purpose), output_summary: "no document reader available on this Nightshift", model: "meterless/ocr", status: "skipped" });
      return null;
    }
    this.calls++;
    if (this.opts.record) this.cache.put({ key: ocrKey(req.imagePng), lane: "vision", model: page.model, raw: JSON.stringify({ text: page.text, lines: page.lines }) });
    this.trace.emit({
      agent_name: req.agent, action: "nightshift.ocr", input_summary: short(req.purpose), output_summary: `${page.lines.length} lines read locally`,
      model: page.model, status: "success", detail: { latency_ms: Date.now() - started, egress: "none" },
    });
    return { ...page, source: "nightshift" };
  }

  async panel<T extends { answer: string; why: string }>(req: PanelReq<T>): Promise<PanelRes> {
    const ask = (lane: Lane) =>
      this.chat({ agent: req.agent, lane, purpose: `${req.purpose} [panel:${lane}]`, system: req.system, user: req.user, schema: req.schema, ruleFallback: req.ruleVote, targetAgent: req.targetAgent });
    const results: ChatRes<T>[] = [];
    if (this.opts.parallel === false) {
      for (const lane of req.lanes) results.push(await ask(lane));
    } else {
      results.push(...(await Promise.all(req.lanes.map(ask))));
    }
    const votes: PanelVote[] = results.map((r) => ({ lane: r.lane, model: r.model, answer: r.json.answer, why: r.json.why, receiptId: r.receiptId, source: r.source }));
    const result = tally(votes);
    this.trace.emit({
      agent_name: req.agent, action: "panel.tally", input_summary: short(req.purpose),
      output_summary: result.outcome === "accepted"
        ? `${result.winner} (${votes.length} votes, agreement ${result.agreement.toFixed(2)})`
        : `undecided: ${votes.map((v) => v.answer).join(" / ")}`,
      target_agent: req.targetAgent ?? null, model: votes.map((v) => v.model).join(","), confidence: result.agreement,
      status: result.outcome === "accepted" ? "success" : "escalated", detail: { votes },
    });
    return result;
  }

  private async complete<T>(req: ChatReq<T>, user: string, model = this.cfg.lanes[req.lane]): Promise<Completion> {
    this.calls++;
    const thinking = req.thinking ?? false;
    const content = req.imagePng
      ? [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(req.imagePng).toString("base64")}` } },
        ]
      : user;
    const body = {
      model,
      messages: [
        { role: "system", content: thinking ? req.system : `/no_think\n${req.system}` },
        { role: "user", content },
      ],
      max_tokens: req.maxTokens ?? (thinking ? 4000 : 900),
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: thinking },
    };
    const started = Date.now();
    const res = await this.fetchImpl(`${this.cfg.nightshift.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.nightshift.token ?? ""}`,
        "meterless-app": "lotline",
        "meterless-trace": this.trace.runId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? (thinking ? 150_000 : 90_000)),
    });
    const json = (await res.json()) as any;
    if (!res.ok || json.error) {
      throw new Error(json?.error?.meterless_detail ?? json?.error?.message ?? `HTTP ${res.status}`);
    }
    const raw = String(json.choices?.[0]?.message?.content ?? "");
    if (!raw.trim()) throw new Error(`${model} returned an empty reply`);
    return {
      raw,
      model: String(json.model ?? json.meterless?.routed_model ?? model),
      receiptId: json.meterless?.receipt_id,
      latencyMs: Date.now() - started,
    };
  }
}
