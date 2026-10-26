import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "@lotline/core";
import { buildServer } from "../src/server.ts";
import type { Runner } from "../src/runs.ts";

const result = (runId: string): RunResult => ({
  runId, status: "complete", mode: "sample",
  scope: { noticeId: "N1", commodity: "romaine", productText: "Chopped romaine", lotCodes: ["GR1-25287-F2"], uncertainty: [] },
  links: [],
  actions: [{ locationId: "S14", locationName: "Store 14", kind: "PULL", lots: ["PK251014007"], rationale: "proven path", linkIds: [], contractId: "ctr_1", approval: "pending" }],
  spreadsheet: { csv: "traceability_lot_code\nPK251014007\n", rows: 1 },
  drafts: [],
  stats: { queries: 1, modelCalls: 1, races: 0, retries: 0, escalations: 0, ms: 5 },
});

const runner: Runner = async (_input, { runId, trace }) => {
  trace.emit({ agent_name: "IntakeAgent", action: "parse_notice", input_summary: "n", output_summary: "scope", status: "success" });
  return result(runId);
};

const server = (approve?: Parameters<typeof buildServer>[0]["approve"]) =>
  buildServer({ runner, approve, mode: "sample", logsDir: mkdtempSync(path.join(tmpdir(), "api-")) }).app;

describe("api", () => {
  it("rejects a body with neither notice nor recall number as JSON, not a stack", async () => {
    const res = await server().inject({ method: "POST", url: "/api/recalls", payload: { asOf: "2026-10-20" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_input" });
    expect(res.body).not.toMatch(/at .*\.ts/);
  });

  it("runs synchronously with wait=true and returns the RunResult", async () => {
    const res = await server().inject({ method: "POST", url: "/api/recalls?wait=true", payload: { notice: "Recall of chopped romaine lots GR1-25287-F2 due to E. coli" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: "sample", status: "complete" });
  });

  it("starts asynchronously, exposes the run, its CSV and its trace stream", async () => {
    const app = server();
    const start = await app.inject({ method: "POST", url: "/api/recalls", payload: { notice: "Recall of chopped romaine lots GR1-25287-F2 due to E. coli" } });
    expect(start.statusCode).toBe(202);
    const { runId } = start.json();
    await new Promise((r) => setTimeout(r, 20));
    const run = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    expect(run.json()).toMatchObject({ runId, status: "complete", events: 1 });
    const csv = await app.inject({ method: "GET", url: `/api/runs/${runId}/spreadsheet.csv` });
    expect(csv.headers["content-type"]).toContain("text/csv");
    const sse = await app.inject({ method: "GET", url: `/api/runs/${runId}/events` });
    expect(sse.body).toContain("event: trace");
    expect(sse.body).toContain("event: done");
  });

  it("approves a pending contract once and traces the operator decision", async () => {
    const app = server();
    const { runId } = (await app.inject({ method: "POST", url: "/api/recalls?wait=true", payload: { notice: "Recall of chopped romaine lots GR1-25287-F2 due to E. coli" } })).json();
    const ok = await app.inject({ method: "POST", url: "/api/approvals/ctr_1", payload: { decision: "approved", by: "qa-lead" } });
    expect(ok.json()).toEqual({ contractId: "ctr_1", approval: "approved" });
    const again = await app.inject({ method: "POST", url: "/api/approvals/ctr_1", payload: { decision: "approved" } });
    expect(again.statusCode).toBe(409);
    const run = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    expect(run.result.actions[0].approval).toBe("approved");
  });

  it("refuses an approval the verifier rejects", async () => {
    const app = server(() => ({ ok: false, reason: "signature mismatch" }));
    await app.inject({ method: "POST", url: "/api/recalls?wait=true", payload: { notice: "Recall of chopped romaine lots GR1-25287-F2 due to E. coli" } });
    const res = await app.inject({ method: "POST", url: "/api/approvals/ctr_1", payload: { decision: "approved" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe("signature mismatch");
  });
});
