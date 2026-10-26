import { useCallback, useEffect, useRef, useState } from "react";
import { decide, getRun, startRecall, streamRun } from "../lib/api.tsx";
import type { Approval, RunResult, RunSummary, TraceEvent } from "../lib/types.tsx";

export type Phase = "idle" | "starting" | "running" | "complete" | "degraded" | "failed";

/**
 * Pacing for the live view. A sample run settles in well under a second, so events that arrive in a burst
 * are released one by one at reading speed; the order and content are exactly what the API sent.
 */
function pace(e: TraceEvent, backlog: number): number {
  const slow: Record<string, number> = {
    "scope.ready": 420,
    "sources.mapped": 360,
    "lots.resolved": 420,
    "link.proposed": 105,
    "trace.forward": 360,
    "link.challenged": 520,
    "retry.requested": 460,
    corroborate: 460,
    "scan.read": 460,
    "panel.tally": 760,
    "link.ruled": 520,
    "injection.flagged": 820,
    "contract.refused": 900,
    "contract.issued": 62,
    "near_miss.checked": 120,
    "plan.ready": 420,
    "spreadsheet.built": 300,
  };
  const ms = slow[e.action] ?? 48;
  return backlog > 260 ? ms / 3 : ms;
}

export interface RunApi {
  phase: Phase;
  runId: string | null;
  events: TraceEvent[];
  result: RunResult | null;
  summary: RunSummary | null;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  backlog: number;
  approvals: Record<string, Approval>;
  busy: Record<string, boolean>;
  approvalErrors: Record<string, string>;
  start: (notice: string) => Promise<string | null>;
  attach: (runId: string) => void;
  skip: () => void;
  decideOn: (contractId: string, decision: "approved" | "rejected") => Promise<void>;
}

export function useRun(): RunApi {
  const [phase, setPhase] = useState<Phase>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [backlog, setBacklog] = useState(0);
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});

  const queue = useRef<TraceEvent[]>([]);
  const pendingDone = useRef<RunSummary | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const close = useRef<() => void>(() => {});
  const generation = useRef(0);

  const finish = useCallback((s: RunSummary) => {
    pendingDone.current = null;
    setSummary(s);
    setEndedAt(performance.now());
    setPhase(s.status === "failed" ? "failed" : s.status === "degraded" ? "degraded" : "complete");
    if (s.status === "failed") setError(s.error ?? "the run failed");
  }, []);

  const pump = useCallback(() => {
    if (timer.current !== undefined) return;
    const next = queue.current.shift();
    setBacklog(queue.current.length);
    if (!next) {
      if (pendingDone.current) finish(pendingDone.current);
      return;
    }
    setEvents((ev) => [...ev, next]);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      pump();
    }, pace(next, queue.current.length));
  }, [finish]);

  const reset = useCallback(() => {
    generation.current++;
    close.current();
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    queue.current = [];
    pendingDone.current = null;
    setEvents([]);
    setSummary(null);
    setError(null);
    setBacklog(0);
    setApprovals({});
    setApprovalErrors({});
    setEndedAt(null);
  }, []);

  const attach = useCallback(
    (id: string) => {
      reset();
      const gen = generation.current;
      setRunId(id);
      setPhase("running");
      setStartedAt(performance.now());
      close.current = streamRun(id, {
        trace: (e) => {
          if (gen !== generation.current) return;
          queue.current.push(e);
          setBacklog(queue.current.length);
          pump();
        },
        done: (s) => {
          if (gen !== generation.current) return;
          pendingDone.current = s;
          if (!queue.current.length && timer.current === undefined) finish(s);
        },
        error: (msg) => {
          if (gen !== generation.current) return;
          // The stream can drop after the run settled; the summary endpoint still has the result.
          getRun(id)
            .then((s) => {
              if (gen !== generation.current) return;
              if (s.status === "running") throw new Error(msg);
              pendingDone.current = s;
              if (!queue.current.length && timer.current === undefined) finish(s);
            })
            .catch((err: Error) => {
              if (gen !== generation.current) return;
              setError(err.message);
              setPhase("failed");
            });
        },
      });
    },
    [finish, pump, reset],
  );

  const start = useCallback(
    async (notice: string) => {
      reset();
      setPhase("starting");
      setStartedAt(performance.now());
      try {
        const { runId: id } = await startRecall(notice);
        attach(id);
        return id;
      } catch (err) {
        setError((err as Error).message);
        setPhase("failed");
        return null;
      }
    },
    [attach, reset],
  );

  const skip = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    const rest = queue.current;
    queue.current = [];
    setBacklog(0);
    if (rest.length) setEvents((ev) => [...ev, ...rest]);
    if (pendingDone.current) finish(pendingDone.current);
  }, [finish]);

  const decideOn = useCallback(
    async (contractId: string, decision: "approved" | "rejected") => {
      setBusy((b) => ({ ...b, [contractId]: true }));
      setApprovalErrors((m) => {
        const next = { ...m };
        delete next[contractId];
        return next;
      });
      try {
        const res = await decide(contractId, decision);
        setApprovals((a) => ({ ...a, [contractId]: res.approval }));
        // The stream has closed by now; mirror the operator event the API just recorded.
        setEvents((ev) => [
          ...ev,
          {
            timestamp: new Date().toISOString(),
            run_id: runId ?? "",
            agent_name: "Operator",
            action: decision === "approved" ? "contract.approve" : "contract.reject",
            input_summary: contractId,
            output_summary: `${decision} by operator`,
            target_agent: "ScoutGate",
            model: null,
            confidence: null,
            retry_count: 0,
            status: "success",
            detail: { contract_id: contractId },
          },
        ]);
      } catch (err) {
        setApprovalErrors((m) => ({ ...m, [contractId]: (err as Error).message }));
      } finally {
        setBusy((b) => ({ ...b, [contractId]: false }));
      }
    },
    [runId],
  );

  useEffect(
    () => () => {
      close.current();
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  return {
    phase,
    runId,
    events,
    result: summary?.result ?? null,
    summary,
    error,
    startedAt,
    endedAt,
    backlog,
    approvals,
    busy,
    approvalErrors,
    start,
    attach,
    skip,
    decideOn,
  };
}
