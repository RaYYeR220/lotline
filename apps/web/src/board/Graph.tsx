import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { BoardState } from "./derive.tsx";
import { layoutGraph, upstreamOf, type LEdge, type LNode } from "./layout.tsx";
import { ACTION_GLYPH, STATUS_LABEL, edgeStatus, type EdgeStatus } from "./status.tsx";

interface Props {
  board: BoardState;
  idle: boolean;
  running: boolean;
  latest?: string;
  selected: string | null;
  onSelect: (edgeId: string | null) => void;
  focusLoc: string | null;
  onLoc: (locationId: string | null) => void;
  onPin: (locationId: string) => void;
}

function describe(e: LEdge, s: EdgeStatus): string {
  if (e.ghost) return `${e.ghost.lot} to ${e.ghost.location}: a different lot${e.ghost.recalled ? ` than the recalled ${e.ghost.recalled}` : ""}. Show the check.`;
  const l = e.link!;
  return `${l.kind} ${l.from.replace(/^\w+:/, "")} to ${l.to.replace(/^\w+:/, "")}, ${STATUS_LABEL[s]}${l.quantity != null ? `, ${l.quantity} cases` : ""}. Show evidence.`;
}

export default function Graph({ board, idle, running, latest, selected, onSelect, focusLoc, onLoc, onPin }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 780, h: 560 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ w: Math.max(640, Math.round(r.width)), h: Math.max(360, Math.round(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lay = useMemo(() => layoutGraph(board, size.w, size.h), [board, size]);
  const lit = useMemo(() => {
    if (selected) {
      const e = lay.edges.find((x) => x.id === selected);
      if (e) return { nodes: new Set([e.a.id, e.b.id]), edges: new Set([e.id]) };
    }
    if (focusLoc) return upstreamOf(lay, `loc:${focusLoc}`);
    return null;
  }, [lay, selected, focusLoc]);

  const empty = lay.nodes.length === 0;
  const onKey = (ev: KeyboardEvent, id: string) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onSelect(selected === id ? null : id);
    }
  };

  const cols = empty ? lay.cols.map((c, i) => ({ ...c, x: Math.max(66, [0.07, 0.25, 0.43, 0.565][i] * size.w), present: true })) : lay.cols;

  return (
    <div className="graph-scroll" ref={box}>
      <svg
        className={`graph${lit ? " has-lit" : ""}${empty ? " is-empty" : ""}`}
        width={lay.width}
        height={empty ? size.h : lay.height}
        viewBox={`0 0 ${lay.width} ${empty ? size.h : lay.height}`}
        role="group"
        aria-label="Trace graph: lots on the left, the locations that received them on the right"
      >
        <defs>
          <radialGradient id="halo">
            <stop offset="0" stopColor="#f1753f" stopOpacity="0.32" />
            <stop offset="1" stopColor="#f1753f" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* furrows: one row per location, one line per column */}
        <g className="furrows" aria-hidden="true">
          {lay.rows.map((y, i) => (
            <line key={i} x1={0} x2={lay.width} y1={y} y2={y} />
          ))}
          {cols
            .filter((c) => c.present)
            .map((c) => (
              <line key={c.label} className="colline" x1={c.x} x2={c.x} y1={lay.top - 6} y2={(empty ? size.h : lay.height) - 12} />
            ))}
          {lay.divider != null && <line className="divider" x1={lay.cols[3].x - 40} x2={lay.width - 12} y1={lay.divider} y2={lay.divider} />}
        </g>

        <g className="colheads" aria-hidden="true">
          {cols
            .filter((c) => c.present)
            .map((c) => (
              <g key={c.label} transform={`translate(${c.x - 7} 0)`}>
                <text className="colhead" y={20}>
                  {c.label}
                </text>
                <text className="colsub" y={35}>
                  {c.sub}
                </text>
              </g>
            ))}
          {lay.divider != null && (
            <text className="divider-label" x={lay.cols[3].x - 7} y={lay.divider - 6}>
              Checked: received a different lot
            </text>
          )}
        </g>

        <g className="edges">
          {lay.edges.map((e) => {
            const s = edgeStatus(e);
            const on = lit?.edges.has(e.id);
            return (
              <g
                key={e.id}
                className={`edge st-${s}${on ? " lit" : ""}${selected === e.id ? " sel" : ""}`}
                tabIndex={0}
                role="button"
                aria-pressed={selected === e.id}
                aria-label={describe(e, s)}
                onClick={() => onSelect(selected === e.id ? null : e.id)}
                onKeyDown={(ev) => onKey(ev, e.id)}
              >
                <path className="halo" d={e.d} style={{ d: `path("${e.d}")` } as CSSProperties} />
                <path className="vis" d={e.d} style={{ d: `path("${e.d}")` } as CSSProperties} />
                {e.link && <path className="spark" d={e.d} pathLength={1} />}
                <path className="hit" d={e.d} />
                {s === "rejected" && (
                  <g className="xmark" transform={`translate(${e.mx} ${e.my})`}>
                    <path d="M-4 -4L4 4M4 -4L-4 4" />
                  </g>
                )}
                {(on || selected === e.id) && e.link && (
                  <g className="elabel" transform={`translate(${e.mx} ${e.my})`}>
                    <rect x={-58} y={-10} width={116} height={20} rx={4} />
                    <text textAnchor="middle" y={4}>
                      {STATUS_LABEL[s]}
                      {e.link.quantity != null ? ` · ${e.link.quantity} cs` : ""}
                      {e.link.at ? ` · ${e.link.at.slice(5)}` : ""}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>

        <g className="nodes">
          {lay.nodes.map((n) => (
            <Node key={n.id} n={n} lit={lit?.nodes.has(n.id) ?? false} width={lay.width} onLoc={onLoc} onPin={onPin} focused={focusLoc === n.code} />
          ))}
        </g>
      </svg>

      {empty && (
        <div className="graph-empty">
          {idle ? (
            <>
              <p className="graph-empty-h">The trace grows here.</p>
              <p>Pick a notice and start a trace. Each link appears as the tracer proposes it; the critic marks it when it rules.</p>
            </>
          ) : board.noLots ? (
            <>
              <p className="graph-empty-h">Nothing to trace.</p>
              <p>
                {board.noLots.charAt(0).toUpperCase() + board.noLots.slice(1)}. The partner network never handled this product, so there is nothing to pull and
                nothing to clear.
              </p>
            </>
          ) : running ? (
            <>
              <p className="graph-empty-h" aria-live="polite">
                {latest ?? "Starting the trace"}
              </p>
              <p>Waiting for the first proposed link.</p>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

const tagText = (a: NonNullable<LNode["action"]>) => `${a.kind}${a.approval === "approved" ? " · approved" : a.approval === "rejected" ? " · rejected" : ""}`;
const tagWidth = (a: NonNullable<LNode["action"]>) => 16 + tagText(a).length * 7;

function fit(text: string, chars: number) {
  const n = Math.floor(chars);
  return text.length <= n ? text : `${text.slice(0, Math.max(4, n - 1)).trimEnd()}…`;
}

function Node({ n, lit, width, onLoc, onPin, focused }: { n: LNode; lit: boolean; width: number; onLoc: (id: string | null) => void; onPin: (id: string) => void; focused: boolean }) {
  const style = { transform: `translate(${n.x}px, ${n.y}px)` } as CSSProperties;
  if (n.col === 3) {
    const a = n.action;
    const cls = a ? `act-${a.kind.toLowerCase()}` : "act-none";
    return (
      <g className={`gnode loc ${cls}${lit ? " lit" : ""}${focused ? " focused" : ""}`} style={style}>
        <rect className="rowhit" x={-14} y={-11} width={width - n.x + 4} height={22} onMouseEnter={() => onLoc(n.code)} onMouseLeave={() => onLoc(null)} onClick={() => onPin(n.code)} />
        <g className="pop">
          {a?.kind === "PULL" && <circle r={11} fill="url(#halo)" />}
          <circle className="dot" r={5.2} />
        </g>
        <text className="loc-code" x={12} y={4}>
          {n.code}
        </text>
        {n.name && (
          <text className="loc-name" x={50} y={4}>
            {fit(n.name, (width - n.x - 14 - (a ? tagWidth(a) + 14 : 0) - 50) / 6.1)}
          </text>
        )}
        {a && (
          <g className="tag" transform={`translate(${width - n.x - 14} 0)`}>
            <text textAnchor="end" y={4}>
              <tspan className="tag-glyph">{ACTION_GLYPH[a.kind]}</tspan> {tagText(a)}
            </text>
          </g>
        )}
      </g>
    );
  }
  const w = n.code.length * 6.9 + 14;
  return (
    <g className={`gnode up${n.ghost ? " ghost" : ""}${n.implicated ? " implicated" : ""}${lit ? " lit" : ""}`} style={style}>
      <g className="pop">
        {n.implicated && <circle r={16} fill="url(#halo)" />}
        <circle className="dot" r={n.implicated ? 7 : 6} />
      </g>
      <g transform={`translate(0 -${n.implicated ? 22 : 20})`}>
        <rect className="code-pill" x={-w / 2} y={-10} width={w} height={20} rx={4} />
        <text className="code" textAnchor="middle" y={4}>
          {n.code}
        </text>
      </g>
      {n.ghost && (
        <text className="ghost-note" textAnchor="middle" y={22}>
          different lot
        </text>
      )}
      {n.implicated && (
        <text className="recalled-note" textAnchor="middle" y={26}>
          recalled
        </text>
      )}
    </g>
  );
}
