import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getExamples, getHealth, spreadsheetUrl } from "../lib/api.tsx";
import { Link, navigate, useLocation } from "../lib/router.tsx";
import type { Example } from "../lib/types.tsx";
import ActionsRail from "./ActionsRail.tsx";
import AgentLog from "./AgentLog.tsx";
import { deriveBoard } from "./derive.tsx";
import EvidenceSheet from "./EvidenceSheet.tsx";
import Graph from "./Graph.tsx";
import { layoutGraph } from "./layout.tsx";
import NoticeRail from "./NoticeRail.tsx";
import { useRun, type Phase } from "./useRun.tsx";
import "./board.css";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Ready",
  starting: "Starting",
  running: "Tracing",
  complete: "Complete",
  degraded: "Degraded",
  failed: "Failed",
};

function clock(ms: number) {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

function Legend() {
  const items: [string, string][] = [
    ["proposed", "proposed"],
    ["proven", "proven"],
    ["contested", "contested"],
    ["unproven", "unproven"],
    ["rejected", "rejected"],
    ["ghost", "different lot"],
  ];
  return (
    <ul className="legend" aria-label="Link status key">
      {items.map(([k, label]) => (
        <li key={k} className={`lg st-${k}`}>
          <svg width="20" height="8" viewBox="0 0 20 8" aria-hidden="true">
            <path className="vis" d="M1 4H19" />
          </svg>
          {label}
        </li>
      ))}
    </ul>
  );
}

export default function Board() {
  const { search } = useLocation();
  const run = useRun();
  const [examples, setExamples] = useState<Example[]>([]);
  const [exampleId, setExampleId] = useState(search.get("example") ?? "N1");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"live" | "sample" | null>(null);
  const [apiDown, setApiDown] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusLoc, setFocusLoc] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const autostarted = useRef(false);
  const attached = useRef(false);

  useEffect(() => {
    document.title = "Lotline · Trace board";
    getExamples()
      .then((xs) => {
        setExamples(xs);
        const want = search.get("example") ?? "N1";
        const hit = xs.find((x) => x.id === want) ?? xs[0];
        if (hit) {
          setExampleId(hit.id);
          setNotice((n) => n || hit.notice);
        }
      })
      .catch(() => setApiDown(true));
    getHealth()
      .then((h) => setMode(h.mode))
      .catch(() => setApiDown(true));
  }, []);

  // Reattach to a run named in the URL (the API replays its events).
  useEffect(() => {
    const id = search.get("run");
    if (id && !attached.current && run.runId !== id) {
      attached.current = true;
      run.attach(id);
    }
  }, [search, run]);

  const begin = useCallback(async () => {
    setSelected(null);
    setPinned(null);
    const id = await run.start(notice);
    if (id) navigate(`/app?${exampleId ? `example=${exampleId}&` : ""}run=${id}`, { replace: true });
  }, [run, notice, exampleId]);

  useEffect(() => {
    if (!autostarted.current && search.get("start") === "1" && notice && run.phase === "idle") {
      autostarted.current = true;
      void begin();
    }
  }, [search, notice, run.phase, begin]);

  const active = run.phase === "starting" || run.phase === "running";
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, [active]);

  const board = useMemo(() => deriveBoard(run.events, run.result, run.approvals), [run.events, run.result, run.approvals]);
  const done = run.phase === "complete" || run.phase === "degraded";
  const elapsed = run.startedAt == null ? 0 : (run.endedAt ?? (active ? now : run.startedAt)) - run.startedAt;
  const resultMode = run.result?.mode ?? mode;
  const latest = run.events.at(-1);

  const selectedEdge = useMemo(() => {
    if (!selected) return null;
    // Same layout the graph uses; only the edge's endpoints and link matter here.
    return layoutGraph(board, 800, 600).edges.find((e) => e.id === selected) ?? null;
  }, [board, selected]);

  const onExample = (id: string) => {
    setExampleId(id);
    const hit = examples.find((x) => x.id === id);
    if (hit) setNotice(hit.notice);
    navigate(id ? `/app?example=${id}` : "/app", { replace: true });
  };

  const counters = [
    { label: "Queries", value: board.counters.queries, hint: "Zetaris queries against partner systems" },
    { label: "Model calls", value: board.counters.modelCalls, hint: "Nightshift model calls, replays and rule fallbacks" },
    { label: "Retries", value: board.counters.retries, hint: "Links sent back for a narrower query" },
    { label: "Panels", value: board.counters.panels, hint: "Three-model votes on contested links" },
  ];

  return (
    <div className="board">
      <div className="board-ground" aria-hidden="true" />
      <header className="topbar">
        <div className="topbar-left">
          <Link className="mark" href="/">
            <i aria-hidden="true" />
            Lotline
          </Link>
          <span className="topbar-title">Trace board</span>
        </div>

        <div className="runstat" aria-live="polite">
          <span className={`phase ph-${run.phase}`}>
            <i aria-hidden="true" />
            {PHASE_LABEL[run.phase]}
          </span>
          <span className="elapsed mono" aria-label="Elapsed">
            {clock(elapsed)}
          </span>
          {run.result && (
            <span className="server-ms" title="Wall time of the run on the server; the board replays its events at reading speed">
              server {run.result.stats.ms < 1000 ? `${run.result.stats.ms} ms` : `${(run.result.stats.ms / 1000).toFixed(1)} s`}
            </span>
          )}
          {run.backlog > 0 && (
            <button className="skip" onClick={run.skip}>
              Show all now
            </button>
          )}
        </div>

        <dl className="counters">
          {counters.map((c) => (
            <div key={c.label} title={c.hint}>
              <dt>{c.label}</dt>
              <dd className="mono">{c.value}</dd>
            </div>
          ))}
        </dl>

        <div className="topbar-right">
          {resultMode && (
            <span className={`mode mode-${resultMode}`} title={resultMode === "sample" ? "Bundled partner snapshot; model replies replayed from recorded live runs" : "Live: Zetaris data layer and Meterless Nightshift"}>
              {resultMode === "sample" ? "Sample mode" : "Live"}
            </span>
          )}
          {done && run.runId ? (
            <a className="csv" href={spreadsheetUrl(run.runId)} download>
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <path d="M6.5 1.5v7M3.5 5.8l3 3 3-3M2 11.5h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              FDA spreadsheet
              <span className="csv-n">{run.result?.spreadsheet.rows ?? 0} rows</span>
            </a>
          ) : (
            <span className="csv is-off" aria-disabled="true" title="Available when the run finishes">
              FDA spreadsheet
            </span>
          )}
        </div>
      </header>

      {(apiDown || run.error) && (
        <p className="banner" role="alert">
          {apiDown ? "The Lotline API is not reachable. Start it with SAMPLE_MODE=true and reload." : run.error}
        </p>
      )}

      <NoticeRail
        examples={examples}
        exampleId={exampleId}
        onExample={onExample}
        notice={notice}
        onNotice={(t) => {
          setNotice(t);
          if (exampleId && examples.find((x) => x.id === exampleId)?.notice !== t) setExampleId("");
        }}
        onStart={() => void begin()}
        busy={active || run.backlog > 0}
        board={board}
        hasRun={run.phase !== "idle"}
      />

      <main className="stage" id="main" aria-label="Trace graph">
        <div className="stage-head">
          <h1 className="stage-title">
            {board.scope ? (
              <>
                <span className="display">{board.scope.commodity}</span>
                <span className="stage-sub">
                  {board.links.length} links · {board.links.filter((l) => l.status === "proven").length} proven
                  {board.links.some((l) => l.status === "unproven") ? ` · ${board.links.filter((l) => l.status === "unproven").length} unproven` : ""}
                  {board.links.some((l) => l.status === "contested") ? ` · ${board.links.filter((l) => l.status === "contested").length} contested` : ""}
                  {board.links.length > 0 && !selectedEdge ? " · select a link for its records" : ""}
                </span>
              </>
            ) : (
              <span className="display">Trace</span>
            )}
          </h1>
          <Legend />
        </div>
        <Graph
          board={board}
          idle={run.phase === "idle"}
          running={active}
          latest={latest ? `${latest.agent_name} · ${latest.action}` : undefined}
          selected={selected}
          onSelect={setSelected}
          focusLoc={focusLoc ?? pinned}
          onLoc={setFocusLoc}
          onPin={(id) => setPinned((p) => (p === id ? null : id))}
        />
        {selectedEdge && <EvidenceSheet edge={selectedEdge} done={done} onClose={() => setSelected(null)} />}
      </main>

      <ActionsRail
        board={board}
        done={done}
        busy={run.busy}
        errors={run.approvalErrors}
        onDecide={(id, d) => void run.decideOn(id, d)}
        focusLoc={focusLoc}
        onFocusLoc={setFocusLoc}
        pinnedLoc={pinned}
      />

      <AgentLog events={run.events} open={logOpen} onToggle={() => setLogOpen((o) => !o)} />
    </div>
  );
}
