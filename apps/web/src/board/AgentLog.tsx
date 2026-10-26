import { useEffect, useMemo, useRef, useState } from "react";
import type { PanelVote, TraceEvent } from "../lib/types.tsx";
import { ModelChip } from "./chips.tsx";
import { STATUS_CHIP } from "./status.tsx";

type Filter = "all" | "argue" | "models" | "queries" | "contracts";

const FILTERS: { id: Filter; label: string; test: (e: TraceEvent) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  {
    id: "argue",
    label: "Critic",
    test: (e) => e.agent_name === "EvidenceCritic" || /^(link\.|panel\.|retry\.|corroborate|scan\.|injection\.)/.test(e.action),
  },
  { id: "models", label: "Model calls", test: (e) => !!e.model },
  { id: "queries", label: "Queries", test: (e) => e.action === "zetaris.query" },
  { id: "contracts", label: "Contracts", test: (e) => e.action.startsWith("contract.") || e.action === "plan.ready" },
];

function Votes({ votes }: { votes: PanelVote[] }) {
  return (
    <span className="log-votes">
      {votes.map((v, i) => (
        <span key={i} className="log-vote" title={`${v.lane}: ${v.why}`}>
          <b className={`vote-chip v-${v.answer.toLowerCase()}`}>{v.answer}</b>
          <ModelChip model={v.model} compact />
        </span>
      ))}
    </span>
  );
}

function DataChip({ e }: { e: TraceEvent }) {
  const backend = String((e.detail as Record<string, unknown> | undefined)?.backend ?? "zetaris");
  return (
    <span className="model-chip is-data" title={`data layer backend: ${backend}`}>
      <span className="model-vendor">Zetaris</span>
      <span className="model-name">{backend === "zetaris" ? "query" : backend}</span>
    </span>
  );
}

export default function AgentLog({ events, open, onToggle }: { events: TraceEvent[]; open: boolean; onToggle: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const t0 = events.length ? Date.parse(events[0].timestamp) : 0;
  const f = FILTERS.find((x) => x.id === filter)!;
  const rows = useMemo(() => events.map((e, i) => ({ e, i })).filter(({ e }) => f.test(e)), [events, f]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, open]);

  return (
    <section className={`log${open ? " is-open" : ""}`} aria-labelledby="log-h">
      <header className="log-head">
        <h2 id="log-h">
          Agent log <span className="log-count">{events.length} events</span>
        </h2>
        <div className="filters" role="group" aria-label="Filter the agent log">
          {FILTERS.map((x) => (
            <button key={x.id} className="filter" aria-pressed={filter === x.id} onClick={() => setFilter(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <button className="log-toggle" onClick={onToggle} aria-expanded={open} aria-controls="log-body">
          {open ? "Collapse" : "Expand"}
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={open ? "flip" : ""}>
            <path d="M1.5 6.5L5 3l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div
        id="log-body"
        className="log-body"
        ref={scroller}
        role="log"
        aria-live="off"
        tabIndex={0}
        aria-label="Agent events"
        onScroll={(ev) => {
          const el = ev.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="log-row log-cols" aria-hidden="true">
          <span>t</span>
          <span>agent → next</span>
          <span>action</span>
          <span>what happened</span>
          <span>status</span>
          <span>served by</span>
        </div>
        {rows.length === 0 && <p className="log-empty">{events.length ? "No events match this filter." : "Agent events stream here once a trace starts."}</p>}
        {rows.map(({ e, i }) => {
          const votes = e.action === "panel.tally" ? ((e.detail as { votes?: PanelVote[] } | undefined)?.votes ?? []) : null;
          const t = Math.max(0, (Date.parse(e.timestamp) - t0) / 1000);
          return (
            <div key={i} className={`log-row st-${e.status}${e.agent_name === "Operator" ? " is-operator" : ""}`}>
              <span className="log-t mono">+{t.toFixed(2)}s</span>
              <span className="log-agents">
                <b>{e.agent_name}</b>
                {e.target_agent && (
                  <>
                    <span className="log-arrow" aria-label="to">
                      →
                    </span>
                    <span>{e.target_agent}</span>
                  </>
                )}
              </span>
              <span className="log-action mono">{e.action}</span>
              <span className="log-sum" title={`${e.input_summary}\n${e.output_summary}`}>
                {e.model && e.action !== "panel.tally" && e.input_summary ? (
                  <>
                    <span className="log-purpose">{e.input_summary}</span> {e.output_summary}
                  </>
                ) : (
                  e.output_summary || e.input_summary
                )}
              </span>
              <span>
                <span className={`status-chip s-${e.status}`}>{STATUS_CHIP[e.status] ?? e.status}</span>
              </span>
              <span className="log-model">
                {votes ? <Votes votes={votes} /> : e.action === "zetaris.query" ? <DataChip e={e} /> : <ModelChip model={e.model} />}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
