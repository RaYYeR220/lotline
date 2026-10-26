import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { RunRegistry, summarize, type Approver, type Runner } from "./runs.ts";

export interface ServerDeps {
  runner: Runner;
  approve?: Approver;
  mode: "live" | "sample";
  /** Built web UI to serve at `/` (optional). */
  staticDir?: string;
  logsDir?: string;
  /** Example notices offered in the UI. */
  examples?: { id: string; title: string; notice: string }[];
}

const RecallBody = z
  .object({
    notice: z.string().trim().min(20, "notice must be at least 20 characters").max(20_000).optional(),
    openFdaRecallNumber: z.string().trim().regex(/^[A-Z]-\d{3,5}-\d{4}$/, "expected an FDA recall number like F-0123-2026").optional(),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "asOf must be an ISO date").optional(),
    options: z.object({ maxRetries: z.number().int().min(0).max(4).optional(), panel: z.boolean().optional() }).optional(),
  })
  .refine((b) => b.notice || b.openFdaRecallNumber, { message: "provide a notice or an openFdaRecallNumber" });

const ApprovalBody = z.object({ decision: z.enum(["approved", "rejected"]), by: z.string().trim().min(1).max(80).default("operator") });

export function buildServer(deps: ServerDeps): { app: FastifyInstance; runs: RunRegistry } {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const runs = new RunRegistry(deps.runner, deps.logsDir);
  void app.register(cors, { origin: true });

  // Errors are JSON with a reason, never a stack trace.
  app.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    void reply.status(status).send({ error: status === 500 ? "internal_error" : "bad_request", detail: err.message ?? "error" });
  });

  app.get("/healthz", async () => ({ ok: true, mode: deps.mode }));
  app.get("/api/examples", async () => deps.examples ?? []);

  app.post("/api/recalls", async (req, reply) => {
    const parsed = RecallBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input", detail: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const record = runs.start(parsed.data);
    const wait = String((req.query as Record<string, string>).wait ?? "") === "true";
    if (!wait) return reply.status(202).send({ runId: record.runId, status: record.status, events: `/api/runs/${record.runId}/events` });
    await record.done;
    if (record.status === "failed") return reply.status(500).send({ error: "run_failed", detail: record.error, runId: record.runId });
    return reply.send(record.result);
  });

  app.get("/api/runs", async () => runs.list().map((r) => ({ runId: r.runId, status: r.status, startedAt: r.startedAt, notice: (r.input.notice ?? r.input.openFdaRecallNumber ?? "").slice(0, 120) })));

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const record = runs.get(req.params.id);
    if (!record) return reply.status(404).send({ error: "not_found", detail: `no run ${req.params.id}` });
    return summarize(record);
  });

  // Server-sent events: replay what happened so far, then stream until the run settles.
  app.get<{ Params: { id: string } }>("/api/runs/:id/events", async (req, reply) => {
    const record = runs.get(req.params.id);
    if (!record) return reply.status(404).send({ error: "not_found", detail: `no run ${req.params.id}` });
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const e of record.trace.events()) send("trace", e);
    const off = record.trace.subscribe((e) => send("trace", e));
    const finish = () => {
      off();
      send("done", summarize(record));
      reply.raw.end();
    };
    if (record.finishedAt) finish();
    else void record.done.then(finish);
    req.raw.on("close", off);
    return reply;
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/spreadsheet.csv", async (req, reply) => {
    const record = runs.get(req.params.id);
    if (!record?.result) return reply.status(404).send({ error: "not_found", detail: "run not found or not finished" });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${record.runId}-fda-sortable.csv"`)
      .send(record.result.spreadsheet.csv);
  });

  app.post<{ Params: { contractId: string } }>("/api/approvals/:contractId", async (req, reply) => {
    const body = ApprovalBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_input", detail: body.error.issues.map((i) => i.message).join("; ") });
    const record = runs.findByContract(req.params.contractId);
    if (!record?.result) return reply.status(404).send({ error: "not_found", detail: `no contract ${req.params.contractId}` });
    const action = record.result.actions.find((a) => a.contractId === req.params.contractId)!;
    if (action.approval !== "pending") return reply.status(409).send({ error: "conflict", detail: `contract is ${action.approval}` });
    const verdict = deps.approve ? deps.approve(record, req.params.contractId, body.data.decision, body.data.by) : { ok: true as const };
    if (!verdict.ok) return reply.status(422).send({ error: "refused", detail: verdict.reason });
    action.approval = body.data.decision;
    record.trace.emit({
      agent_name: "Operator", action: `contract.${body.data.decision === "approved" ? "approve" : "reject"}`,
      input_summary: `${action.kind} ${action.locationName}`, output_summary: `${body.data.decision} by ${body.data.by}`,
      status: "success", detail: { contract_id: req.params.contractId },
    });
    return { contractId: req.params.contractId, approval: action.approval };
  });

  if (deps.staticDir) {
    void app.register(fastifyStatic, { root: deps.staticDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "not_found", detail: req.url });
      return reply.sendFile("index.html");
    });
  }

  return { app, runs };
}
