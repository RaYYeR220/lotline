import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionKind } from "../lib/types.tsx";
import type { ActionView, BoardState, Refusal } from "./derive.tsx";
import { ActionChip } from "./chips.tsx";
import { ACTION_GLYPH, APPROVAL_LABEL } from "./status.tsx";

const KINDS: ActionKind[] = ["PULL", "HOLD", "CLEAR", "ESCALATE"];

interface Props {
  board: BoardState;
  done: boolean;
  busy: Record<string, boolean>;
  errors: Record<string, string>;
  onDecide: (contractId: string, decision: "approved" | "rejected") => void;
  focusLoc: string | null;
  onFocusLoc: (id: string | null) => void;
  pinnedLoc: string | null;
}

const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id);

function Seal() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="seal">
      <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.2" />
      <path d="M4.6 7.1l1.6 1.6 3.2-3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefusalCard({ r, replacement }: { r: Refusal; replacement?: ActionView }) {
  const score = r.summary.match(/score ([\d.]+)/)?.[1];
  return (
    <article className="refusal" aria-labelledby={`ref-${r.target}`}>
      <p className="refusal-kicker">
        <b className="stamp-chip">Refused</b>
        <span>Scout Intent · {r.reason}</span>
      </p>
      <h4 id={`ref-${r.target}`} className="refusal-title">
        {r.intent.toUpperCase()} {r.target}
      </h4>
      <p className="refusal-why">
        {r.reason === "injection"
          ? `Asked for by text inside a partner record, not by evidence${score ? `; injection guard score ${score}` : ""}. ${r.provenEvidence ?? 0} proven records behind it.`
          : r.summary}
      </p>
      {r.flagged && (
        <figure className="quoted">
          <figcaption>
            <span className="mono">{r.flagged.row}</span> · treated as data
          </figcaption>
          {r.flagged.text ? (
            <blockquote className="mono">“{r.flagged.text}”</blockquote>
          ) : (
            <p className="muted small">The note text arrives with the finished run.</p>
          )}
          <ul className="signal-chips" aria-label="Signals">
            {r.flagged.signals.map((s) => (
              <li key={s} className="mono">
                {s}
              </li>
            ))}
          </ul>
        </figure>
      )}
      {replacement && (
        <p className="refusal-instead">
          Instead <ActionChip kind={replacement.kind} size="sm" /> <strong>{replacement.locationId}</strong>
          {replacement.locationName ? ` ${replacement.locationName}` : ""} · {APPROVAL_LABEL[replacement.approval].toLowerCase()}
        </p>
      )}
    </article>
  );
}

function ActionCard({ a, done, busy, error, onDecide, focused, pinned, onFocusLoc }: {
  a: ActionView;
  done: boolean;
  busy: boolean;
  error?: string;
  onDecide: Props["onDecide"];
  focused: boolean;
  pinned: boolean;
  onFocusLoc: Props["onFocusLoc"];
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (pinned) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [pinned]);
  return (
    <article
      ref={ref}
      className={`acard a-${a.kind.toLowerCase()} ap-${a.approval}${focused || pinned ? " is-focused" : ""}`}
      onMouseEnter={() => onFocusLoc(a.locationId)}
      onMouseLeave={() => onFocusLoc(null)}
      onFocus={() => onFocusLoc(a.locationId)}
      onBlur={() => onFocusLoc(null)}
      aria-labelledby={`ac-${a.locationId}`}
    >
      <header className="acard-head">
        <ActionChip kind={a.kind} />
        <h4 id={`ac-${a.locationId}`}>
          <span className="mono">{a.locationId}</span>
          {a.locationName && <span className="acard-name">{a.locationName}</span>}
        </h4>
      </header>
      <p className="acard-why">{a.rationale ?? <span className="muted">Rationale arrives with the finished plan.</span>}</p>
      {a.lots.length > 0 && (
        <p className="acard-lots">
          {a.lots.map((l) => (
            <span key={l} className="lot-pill mono">
              {l}
            </span>
          ))}
        </p>
      )}
      <footer className="acard-foot">
        {a.contractId ? (
          <span className="contract" title={`Scout execution contract ${a.contractId}, signature verified by the API on approval`}>
            <Seal />
            <span className="mono">{shortId(a.contractId)}</span>
            <span>signed</span>
          </span>
        ) : (
          <span className="contract muted">no contract</span>
        )}
        {a.approval === "pending" ? (
          <span className="decide">
            <button
              className="btn btn-approve"
              disabled={!done || busy}
              aria-busy={busy}
              onClick={() => onDecide(a.contractId, "approved")}
              title={done ? undefined : "Available once the run finishes"}
            >
              Approve
            </button>
            <button className="btn btn-reject" disabled={!done || busy} onClick={() => onDecide(a.contractId, "rejected")}>
              Reject
            </button>
          </span>
        ) : (
          <span className={`approval ap-${a.approval}`}>
            {a.approval === "approved" ? "✓ " : a.approval === "rejected" ? "✕ " : ""}
            {APPROVAL_LABEL[a.approval]}
            {a.approval === "approved" || a.approval === "rejected" ? " by operator" : ""}
          </span>
        )}
      </footer>
      {error && (
        <p className="acard-err" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

export default function ActionsRail({ board, done, busy, errors, onDecide, focusLoc, onFocusLoc, pinnedLoc }: Props) {
  const [filter, setFilter] = useState<ActionKind | "ALL">("ALL");
  const counts = useMemo(() => Object.fromEntries(KINDS.map((k) => [k, board.actions.filter((a) => a.kind === k).length])) as Record<ActionKind, number>, [board.actions]);
  const pending = board.actions.filter((a) => a.approval === "pending").length;
  const approved = board.actions.filter((a) => a.approval === "approved").length;
  const list = filter === "ALL" ? board.actions : board.actions.filter((a) => a.kind === filter);
  const ordered = useMemo(() => [...list].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.locationId.localeCompare(b.locationId)), [list]);
  const byTarget = new Map(board.actions.map((a) => [a.locationId, a]));

  return (
    <section className="rail rail-right" aria-labelledby="actions-h">
      <header className="rail-head">
        <h2 id="actions-h">Actions</h2>
        <p className="rail-sub">One signed contract per location</p>
      </header>

      {board.actions.length > 0 ? (
        <div className="tally">
          <div className="tally-row" aria-hidden="true">
            {[...board.actions]
              .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))
              .map((a) => (
                <i key={a.locationId} className={`tdot a-${a.kind.toLowerCase()}${a.approval === "pending" ? " is-pending" : ""}`} />
              ))}
          </div>
          <dl className="tally-counts">
            {KINDS.map((k) => (
              <div key={k} className={counts[k] ? "" : "is-zero"}>
                <dt>
                  <span aria-hidden="true">{ACTION_GLYPH[k]}</span> {k}
                </dt>
                <dd>{counts[k]}</dd>
              </div>
            ))}
          </dl>
          {(pending > 0 || approved > 0) && (
            <p className="tally-note">
              {pending > 0 && (
                <>
                  <strong>{pending}</strong> PULL {pending === 1 ? "contract waits" : "contracts wait"} for a person’s approval
                </>
              )}
              {pending > 0 && approved > 0 && " · "}
              {approved > 0 && <>{approved} approved</>}
            </p>
          )}
        </div>
      ) : (
        <p className="rail-empty">{board.planReady ? "No locations needed an action." : "Contracts appear here as Scout signs them."}</p>
      )}

      <div className="rail-scroll">
        {board.refusals.map((r) => (
          <RefusalCard key={`${r.intent}-${r.target}-${r.seq}`} r={r} replacement={byTarget.get(r.target)} />
        ))}

        {board.actions.length > 0 && (
          <div className="filters" role="group" aria-label="Filter actions">
            {(["ALL", ...KINDS] as const).map((k) => {
              const n = k === "ALL" ? board.actions.length : counts[k];
              if (k !== "ALL" && !n) return null;
              return (
                <button key={k} className="filter" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {k === "ALL" ? "All" : k} <span className="filter-n">{n}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="cards">
          {ordered.map((a) => (
            <ActionCard
              key={a.locationId}
              a={a}
              done={done}
              busy={!!busy[a.contractId]}
              error={errors[a.contractId]}
              onDecide={onDecide}
              focused={focusLoc === a.locationId}
              pinned={pinnedLoc === a.locationId}
              onFocusLoc={onFocusLoc}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
