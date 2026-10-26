import type { Example } from "../lib/types.tsx";
import type { BoardState } from "./derive.tsx";

const PARTNERS: { key: string; name: string; holds: string }[] = [
  { key: "grower", name: "Grower", holds: "harvest, cooling" },
  { key: "packer", name: "Packer", holds: "receipts, repacks, shipments" },
  { key: "wms", name: "Distributor", holds: "pallets, receiving, store orders" },
  { key: "carrier", name: "Carrier", holds: "bills of lading" },
  { key: "retail", name: "Retailer", holds: "store receipts" },
];

const fmtDate = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

interface Props {
  examples: Example[];
  exampleId: string;
  onExample: (id: string) => void;
  notice: string;
  onNotice: (text: string) => void;
  onStart: () => void;
  busy: boolean;
  board: BoardState;
  hasRun: boolean;
}

export default function NoticeRail({ examples, exampleId, onExample, notice, onNotice, onStart, busy, board, hasRun }: Props) {
  const s = board.scope;
  const tooShort = notice.trim().length < 20;
  return (
    <section className="rail rail-left" aria-labelledby="notice-h">
      <form
        className="notice"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !tooShort) onStart();
        }}
      >
        <header className="rail-head">
          <h2 id="notice-h">Recall notice</h2>
          <p className="rail-sub">FDA enforcement report or a recall email</p>
        </header>
        <label className="field-label" htmlFor="example">
          Sample notice
        </label>
        <div className="select-wrap">
          <select id="example" value={exampleId} onChange={(e) => onExample(e.target.value)} disabled={busy}>
            <option value="">Write your own</option>
            {examples.map((x) => (
              <option key={x.id} value={x.id}>
                {x.id} · {x.title}
              </option>
            ))}
          </select>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 3.5L5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
        <label className="field-label" htmlFor="notice-text">
          Notice text
        </label>
        <textarea
          id="notice-text"
          className="paper mono"
          value={notice}
          onChange={(e) => onNotice(e.target.value)}
          spellCheck={false}
          rows={8}
          disabled={busy}
          placeholder="Paste an FDA enforcement report or a recall email (at least 20 characters)."
        />
        <button type="submit" className="pill-cta start" disabled={busy || tooShort}>
          <i aria-hidden="true" />
          {busy ? "Tracing…" : hasRun ? "Trace again" : "Start trace"}
        </button>
      </form>

      <section className="scope" aria-labelledby="scope-h" aria-live="polite">
        <h3 id="scope-h" className="mini-h">
          Scope
        </h3>
        {s ? (
          <div className="scope-body">
            <p className="scope-commodity display">{s.commodity}</p>
            <p className="scope-product">{s.productText}</p>
            <dl className="kv">
              {s.firm && (
                <div>
                  <dt>Firm</dt>
                  <dd>{s.firm}</dd>
                </div>
              )}
              <div>
                <dt>{s.lotCodes.length ? "Lot codes" : "Window"}</dt>
                <dd className={s.lotCodes.length ? "mono" : undefined}>
                  {s.lotCodes.length ? s.lotCodes.join(", ") : s.dateFrom ? `${fmtDate(s.dateFrom)} – ${fmtDate(s.dateTo)}` : "not stated"}
                </dd>
              </div>
              {board.implicated.length > 0 && (
                <div>
                  <dt>Implicated</dt>
                  <dd className="mono">{board.implicated.join(", ")}</dd>
                </div>
              )}
              <div>
                <dt>Hazard</dt>
                <dd>{s.hazard ?? "not stated"}</dd>
              </div>
              {s.recallClass && (
                <div>
                  <dt>Class</dt>
                  <dd>
                    <span className="class-chip">Class {s.recallClass}</span>
                  </dd>
                </div>
              )}
              <div>
                <dt>Open questions</dt>
                <dd>{s.uncertainty.length ? s.uncertainty.join("; ") : "none"}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="muted small">The intake agent reads the notice into a scope: commodity, lots or a date window, hazard, and what it is unsure of.</p>
        )}
      </section>

      <section className="systems" aria-labelledby="systems-h">
        <h3 id="systems-h" className="mini-h">
          Partner systems <span className="via">queried in place via Zetaris</span>
        </h3>
        <ul>
          {PARTNERS.map((p) => {
            const n = board.systems[p.key] ?? 0;
            return (
              <li key={p.key} className={n ? "is-hit" : ""}>
                <i className="sys-dot" aria-hidden="true" />
                <span className="sys-name">{p.name}</span>
                <span className="sys-holds">{p.holds}</span>
                <span className="sys-n mono" aria-label={`${n} queries`}>
                  {n}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
