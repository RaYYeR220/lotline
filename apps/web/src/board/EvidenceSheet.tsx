import { useEffect, useRef } from "react";
import type { LEdge } from "./layout.tsx";
import { STATUS_LABEL, edgeStatus } from "./status.tsx";
import { ModelChip } from "./chips.tsx";

const KIND_TEXT: Record<string, string> = {
  "derived-from": "packed from",
  "harvested-as": "harvested as",
  "received-as": "received as pallet",
  "shipped-to": "shipped to",
};

const code = (id: string) => id.replace(/^(lot|lpn|loc):/, "");

export default function EvidenceSheet({ edge, done, onClose }: { edge: LEdge; done: boolean; onClose: () => void }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    head.current?.focus();
  }, [edge.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const s = edgeStatus(edge);
  const l = edge.link;

  return (
    <aside className="sheet" aria-labelledby="sheet-h">
      <header className="sheet-head">
        <div>
          <p className="sheet-kicker">
            <span className={`status-chip st-${s}`}>{STATUS_LABEL[s]}</span>
            {l && <span className="mono sheet-id">{l.id}</span>}
          </p>
          <h3 id="sheet-h" ref={head} tabIndex={-1} className="sheet-title">
            {edge.ghost ? (
              <>
                {edge.ghost.lot} <span className="sheet-verb">is not</span> {edge.ghost.recalled || "a recalled lot"}
              </>
            ) : (
              <>
                {code(l!.from)} <span className="sheet-verb">{KIND_TEXT[l!.kind] ?? l!.kind}</span> {code(l!.to)}
              </>
            )}
          </h3>
          {l && (
            <p className="sheet-meta">
              {l.at}
              {l.quantity != null ? ` · ${l.quantity} cases` : ""}
              {l.confidence != null && done
                ? s === "proven"
                  ? ` · confidence ${l.confidence.toFixed(2)}`
                  : l.votes?.length
                    ? ` · panel agreement ${l.confidence.toFixed(2)}`
                    : ""
                : ""}
              {edge.b.name ? ` · ${edge.b.name}` : ""}
            </p>
          )}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close evidence">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {edge.ghost ? (
        <section className="sheet-sec">
          <h4>{edge.ghost.recalled ? "Near-miss check · LotMatcher" : "Clearance evidence · ActionPlanner"}</h4>
          {edge.ghost.recalled ? (
            <p className="sheet-p">
              {edge.ghost.location} received <span className="mono">{edge.ghost.lot}</span>, not the recalled{" "}
              <span className="mono">{edge.ghost.recalled}</span>: {edge.ghost.note}.
            </p>
          ) : (
            <p className="sheet-p">
              {edge.ghost.location}: {edge.ghost.note}.
            </p>
          )}
          <p className="sheet-p muted">A CLEAR is only signed when every lot a location received is traced to inputs outside the recall.</p>
        </section>
      ) : (
        <>
          <section className="sheet-sec">
            <h4>Records</h4>
            {l!.evidence.length ? (
              <ol className="records">
                {l!.evidence.map((ev, i) => (
                  <li key={i} className="rec">
                    <p className="rec-head">
                      <span className="rec-src">
                        {ev.source}.{ev.table}
                      </span>
                      <span className="mono">{ev.rowKey}</span>
                    </p>
                    <dl className="rec-fields">
                      {Object.entries(ev.fields).map(([k, v]) => (
                        <div key={k} className={k === "notes" ? "is-note" : undefined}>
                          <dt>{k}</dt>
                          <dd className="mono">{v || "—"}</dd>
                        </div>
                      ))}
                    </dl>
                    <details className="rec-sql">
                      <summary>
                        query <span className="mono">{ev.queryId.slice(0, 8)}</span>
                      </summary>
                      <code className="mono">{ev.sql}</code>
                    </details>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="sheet-p muted">{done ? "No records were attached to this link." : `${l!.summary}. The records arrive with the finished run.`}</p>
            )}
          </section>

          <section className="sheet-sec">
            <h4>Evidence critic</h4>
            {l!.notes.length ? (
              <ul className="notes">
                {l!.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : (
              <p className="sheet-p muted">
                {s === "proposed" ? "Not ruled yet." : "No objections: the records meet the proof bar for this kind of link."}
              </p>
            )}
            {l!.retries > 0 && <p className="sheet-p muted">Sent back for {l!.retries} narrower {l!.retries === 1 ? "query" : "queries"}.</p>}
            {l!.votes && l!.votes.length > 0 && (
              <ul className="votes-list" aria-label="Panel votes">
                {l!.votes.map((v, i) => (
                  <li key={i}>
                    <b className={`vote-chip v-${v.answer.toLowerCase()}`}>{v.answer}</b>
                    <ModelChip model={v.model} />
                    <span className="vote-why">{v.why}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
