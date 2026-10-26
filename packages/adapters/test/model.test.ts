import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TraceLog, loadConfig } from "@lotline/core";
import { NightshiftGateway, SampleGateway, cacheKey } from "../src/model/index.ts";

const Verdict = z.object({ match: z.boolean(), why: z.string() });
const tmp = () => mkdtempSync(path.join(tmpdir(), "model-"));
const trace = () => new TraceLog("t", { dir: tmp(), stdout: false });

function fakeFetch(contents: string[], model = "nvidia/nemotron-3.5-lightning-30b-a3b") {
  const calls: any[] = [];
  const impl = async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    const content = contents[Math.min(calls.length - 1, contents.length - 1)];
    return new Response(JSON.stringify({
      model,
      choices: [{ message: { content } }],
      usage: { completion_tokens: 10 },
      meterless: { receipt_id: `rcpt_${calls.length}`, routed_model: model, usage: { latency_ms: 12 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("NightshiftGateway.chat", () => {
  it("parses fenced JSON, pins the lane model and logs model + receipt", async () => {
    const t = trace();
    const { impl, calls } = fakeFetch(["Here:\n```json\n{\"match\": true, \"why\": \"zero padding\"}\n```"]);
    const gw = new NightshiftGateway(loadConfig({}), t, { fetchImpl: impl, cacheFile: path.join(tmp(), "c.jsonl") });
    const res = await gw.chat({ agent: "LotMatcher", lane: "reason", purpose: "match", system: "s", user: "u", schema: Verdict, ruleFallback: () => ({ match: false, why: "rule" }) });
    expect(res.json).toEqual({ match: true, why: "zero padding" });
    expect(res.source).toBe("nightshift");
    expect(res.receiptId).toBe("rcpt_1");
    expect(calls[0].model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(calls[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    const ev = t.events().find((e) => e.action === "nightshift.chat")!;
    expect(ev.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(ev.agent_name).toBe("LotMatcher");
    expect(ev.detail?.receipt_id).toBe("rcpt_1");
  });

  it("repairs once, then falls back to the rule lane and says so", async () => {
    const t = trace();
    const { impl, calls } = fakeFetch(["not json", "still not json"]);
    const gw = new NightshiftGateway(loadConfig({}), t, { fetchImpl: impl, cacheFile: path.join(tmp(), "c.jsonl") });
    const res = await gw.chat({ agent: "EvidenceCritic", lane: "judge", purpose: "p", system: "s", user: "u", schema: Verdict, ruleFallback: () => ({ match: false, why: "rule" }) });
    expect(calls).toHaveLength(2);
    expect(res.source).toBe("rules");
    expect(res.model).toBe("rules/fallback");
    expect(t.events().some((e) => e.status === "needs_revision")).toBe(true);
  });

  it("records live answers to the cache file when recording is on", async () => {
    const file = path.join(tmp(), "c.jsonl");
    const { impl } = fakeFetch(["{\"match\": false, \"why\": \"different seq\"}"]);
    const gw = new NightshiftGateway(loadConfig({}), trace(), { fetchImpl: impl, cacheFile: file, record: true });
    await gw.chat({ agent: "A", lane: "fast", purpose: "p", system: "s", user: "u", schema: Verdict, ruleFallback: () => ({ match: true, why: "r" }) });
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line.key).toBe(cacheKey("fast", "s", "u"));
    expect(line.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
  });
});

describe("SampleGateway", () => {
  it("answers from the cache on a hit and from rules on a miss", async () => {
    const file = path.join(tmp(), "c.jsonl");
    writeFileSync(file, JSON.stringify({ key: cacheKey("reason", "s", "hit"), lane: "reason", model: "nvidia/nemotron-3.5-lightning-30b-a3b", raw: "{\"match\": true, \"why\": \"cached\"}", receiptId: "rcpt_x" }) + "\n");
    const t = trace();
    const gw = new SampleGateway(t, { cacheFile: file });
    const hit = await gw.chat({ agent: "A", lane: "reason", purpose: "p", system: "s", user: "hit", schema: Verdict, ruleFallback: () => ({ match: false, why: "rule" }) });
    const miss = await gw.chat({ agent: "A", lane: "reason", purpose: "p", system: "s", user: "miss", schema: Verdict, ruleFallback: () => ({ match: false, why: "rule" }) });
    expect(hit.json.why).toBe("cached");
    expect(hit.model).toBe("cache/nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(miss.model).toBe("rules/fallback");
    expect(t.events().map((e) => e.model)).toEqual(["cache/nvidia/nemotron-3.5-lightning-30b-a3b", "rules/fallback"]);
  });
});

describe("panel", () => {
  const Vote = z.object({ answer: z.enum(["SAME", "DIFFERENT", "UNPROVEN"]), why: z.string() });
  const run = async (answers: string[]) => {
    let i = 0;
    const impl = (async () => new Response(JSON.stringify({
      model: ["m-reason", "m-judge", "m-fast"][i],
      choices: [{ message: { content: JSON.stringify({ answer: answers[i++], why: "w" }) } }],
      meterless: { receipt_id: `r${i}` },
    }), { status: 200 })) as unknown as typeof fetch;
    const gw = new NightshiftGateway(loadConfig({}), trace(), { fetchImpl: impl, cacheFile: path.join(tmp(), "c.jsonl"), parallel: false });
    return gw.panel({ agent: "EvidenceCritic", purpose: "contest", system: "s", user: "u", schema: Vote, lanes: ["reason", "judge", "fast"], ruleVote: () => ({ answer: "UNPROVEN" as const, why: "rule" }) });
  };

  it("accepts a two-thirds majority", async () => {
    const res = await run(["SAME", "SAME", "UNPROVEN"]);
    expect(res.outcome).toBe("accepted");
    expect(res.winner).toBe("SAME");
    expect(res.agreement).toBeCloseTo(2 / 3);
    expect(res.votes.map((v) => v.model)).toEqual(["m-reason", "m-judge", "m-fast"]);
  });

  it("is undecided when nobody agrees", async () => {
    const res = await run(["SAME", "DIFFERENT", "UNPROVEN"]);
    expect(res.outcome).toBe("undecided");
    expect(res.winner).toBeUndefined();
  });
});
