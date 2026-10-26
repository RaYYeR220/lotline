import type { Approval, Example, RunSummary, TraceEvent } from "./types.tsx";

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; detail?: string };
  if (!res.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

export async function getExamples(): Promise<Example[]> {
  return json<Example[]>(await fetch("/api/examples"));
}

export async function getHealth(): Promise<{ ok: boolean; mode: "live" | "sample" }> {
  return json(await fetch("/healthz"));
}

export async function startRecall(notice: string): Promise<{ runId: string; events: string }> {
  return json(
    await fetch("/api/recalls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notice }),
    }),
  );
}

export async function getRun(runId: string): Promise<RunSummary> {
  return json(await fetch(`/api/runs/${encodeURIComponent(runId)}`));
}

export async function decide(contractId: string, decision: "approved" | "rejected", by = "operator"): Promise<{ contractId: string; approval: Approval }> {
  return json(
    await fetch(`/api/approvals/${encodeURIComponent(contractId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, by }),
    }),
  );
}

export const spreadsheetUrl = (runId: string) => `/api/runs/${encodeURIComponent(runId)}/spreadsheet.csv`;

/** Subscribe to a run's server-sent events. The server replays history, then streams until the run settles. */
export function streamRun(
  runId: string,
  on: { trace: (e: TraceEvent) => void; done: (s: RunSummary) => void; error: (msg: string) => void },
): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  let settled = false;
  es.addEventListener("trace", (m) => on.trace(JSON.parse((m as MessageEvent<string>).data) as TraceEvent));
  es.addEventListener("done", (m) => {
    settled = true;
    es.close();
    on.done(JSON.parse((m as MessageEvent<string>).data) as RunSummary);
  });
  es.onerror = () => {
    if (settled) return;
    es.close();
    on.error("lost the event stream from the API");
  };
  return () => {
    settled = true;
    es.close();
  };
}
