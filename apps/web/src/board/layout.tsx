// Column layout for the trace graph: source lots -> packed lots -> DC pallets -> locations.
import type { ActionView, BoardState, GLink, Ghost } from "./derive.tsx";

export interface LNode {
  id: string;
  code: string;
  col: number;
  x: number;
  y: number;
  ghost: boolean;
  implicated: boolean;
  seq: number;
  name?: string;
  action?: ActionView;
}

export interface LEdge {
  id: string;
  a: LNode;
  b: LNode;
  d: string;
  mx: number;
  my: number;
  link?: GLink;
  ghost?: Ghost;
  seq: number;
}

export interface Layout {
  nodes: LNode[];
  edges: LEdge[];
  width: number;
  height: number;
  cols: { x: number; label: string; sub: string; present: boolean }[];
  rows: number[];
  divider: number | null;
  top: number;
}

const COLS = [
  { label: "Source lots", sub: "grower harvest" },
  { label: "Packed lots", sub: "packer repacks" },
  { label: "DC pallets", sub: "distributor WMS" },
  { label: "Locations", sub: "store receipts" },
];

const strip = (s: string) => s.replace(/^(lot|lpn|loc|ghost):/, "");

export function layoutGraph(board: BoardState, width: number, minHeight: number): Layout {
  const col = new Map<string, number>();
  const seq = new Map<string, number>();
  const put = (id: string, c: number, s: number) => {
    if (!col.has(id)) {
      col.set(id, c);
      seq.set(id, s);
    }
  };

  const pairs: { from: string; to: string; link?: GLink; ghost?: Ghost; seq: number; id: string }[] = [];
  for (const l of board.links) {
    let a: string, b: string, ca: number;
    if (l.kind === "derived-from") [a, b, ca] = [l.to, l.from, 0];
    else if (l.kind === "harvested-as") [a, b, ca] = [l.from, l.to, 0];
    else if (l.kind === "received-as") [a, b, ca] = [l.from, l.to, 1];
    else [a, b, ca] = [l.from, l.to, 2];
    put(a, ca, l.seq);
    put(b, ca + 1, l.seq);
    pairs.push({ from: a, to: b, link: l, seq: l.seq, id: l.id });
  }
  const ghostStart = 10_000;
  board.ghosts.forEach((g, i) => {
    const a = `ghost:${g.lot}`, b = `loc:${g.location}`;
    put(a, 1, ghostStart + i);
    put(b, 3, ghostStart + i);
    pairs.push({ from: a, to: b, ghost: g, seq: ghostStart + i, id: `ghost:${g.lot}|${g.location}` });
  });
  board.actions.forEach((a, i) => put(`loc:${a.locationId}`, 3, ghostStart * 2 + i));

  const present = [0, 1, 2, 3].map((c) => [...col.values()].includes(c));
  const usesSource = present[0];
  const fx = usesSource ? [0.07, 0.25, 0.43, 0.565] : [0, 0.09, 0.315, 0.53];
  const xs = fx.map((f, i) => (i === 0 ? Math.max(66, f * width) : f * width));

  const actionOf = new Map(board.actions.map((a) => [a.locationId, a]));
  const implicated = new Set(board.implicated);
  const nodes = new Map<string, LNode>();
  for (const [id, c] of col) {
    const code = strip(id);
    nodes.set(id, {
      id,
      code,
      col: c,
      x: xs[c],
      y: 0,
      ghost: id.startsWith("ghost:"),
      implicated: implicated.has(code),
      seq: seq.get(id) ?? 0,
      name: c === 3 ? board.names[code] ?? actionOf.get(code)?.locationName : undefined,
      action: c === 3 ? actionOf.get(code) : undefined,
    });
  }

  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const p of pairs) {
    if (p.ghost) continue;
    children.set(p.from, [...(children.get(p.from) ?? []), p.to]);
    parents.set(p.to, [...(parents.get(p.to) ?? []), p.from]);
  }
  const byCol = (c: number) => [...nodes.values()].filter((n) => n.col === c).sort((a, b) => a.seq - b.seq || a.code.localeCompare(b.code));

  // Locations: the traced ones grouped under their pallets, then the ones cleared on a different lot.
  const pallets = byCol(2);
  const pIndex = new Map(pallets.map((p, i) => [p.id, i]));
  const locs = byCol(3);
  const traced = locs.filter((n) => parents.has(n.id));
  const rest = locs.filter((n) => !parents.has(n.id));
  const key = (n: LNode) => {
    const ps = (parents.get(n.id) ?? []).map((p) => pIndex.get(p) ?? 0);
    return ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : 0;
  };
  traced.sort((a, b) => key(a) - key(b) || a.code.localeCompare(b.code));
  rest.sort((a, b) => {
    const ka = a.action?.kind === "CLEAR" ? 1 : 0, kb = b.action?.kind === "CLEAR" ? 1 : 0;
    return ka - kb || a.code.localeCompare(b.code);
  });

  const top = 52, bottom = 14, gapRest = traced.length && rest.length ? 32 : 0;
  const n = Math.max(1, traced.length + rest.length);
  const rowH = Math.max(18, Math.min(34, (minHeight - top - bottom - gapRest) / n));
  const content = n * rowH + gapRest;
  const height = Math.max(minHeight, top + content + bottom);
  const y0 = top + Math.max(0, (height - top - bottom - content) / 2) + rowH / 2;
  const rows: number[] = [];
  traced.forEach((nd, i) => {
    nd.y = y0 + i * rowH;
    rows.push(nd.y);
  });
  rest.forEach((nd, i) => {
    nd.y = y0 + (traced.length + i) * rowH + gapRest;
    rows.push(nd.y);
  });
  const divider = gapRest ? y0 + traced.length * rowH - rowH / 2 + gapRest / 2 : null;

  // Upstream columns sit at the centre of what they feed, pushed apart where they would touch.
  const mid = (top + height - bottom) / 2;
  const ghostKids = new Map<string, string[]>();
  for (const p of pairs) if (p.ghost) ghostKids.set(p.from, [...(ghostKids.get(p.from) ?? []), p.to]);
  for (const c of [2, 1, 0]) {
    const column = byCol(c);
    const lone: LNode[] = [];
    for (const nd of column) {
      const kids = (nd.ghost ? ghostKids.get(nd.id) : children.get(nd.id)) ?? [];
      const ys = kids.map((k) => nodes.get(k)?.y).filter((v): v is number => v != null && v > 0);
      if (ys.length) nd.y = ys.reduce((s, v) => s + v, 0) / ys.length;
      else lone.push(nd);
    }
    lone.forEach((nd, i) => (nd.y = mid + (i - (lone.length - 1) / 2) * 52));
    spread(column, c === 1 && column.some((x) => x.ghost) ? 60 : 48, top + 14, height - bottom);
  }

  const edges: LEdge[] = pairs
    .map((p) => {
      const a = nodes.get(p.from)!, b = nodes.get(p.to)!;
      const ax = a.x + 7, bx = b.x - 7, cx = (ax + bx) / 2;
      return {
        id: p.id,
        a,
        b,
        d: `M${ax.toFixed(1)} ${a.y.toFixed(1)}C${cx.toFixed(1)} ${a.y.toFixed(1)} ${cx.toFixed(1)} ${b.y.toFixed(1)} ${bx.toFixed(1)} ${b.y.toFixed(1)}`,
        mx: cx,
        my: (a.y + b.y) / 2,
        link: p.link,
        ghost: p.ghost,
        seq: p.seq,
      };
    })
    .sort((x, y) => x.seq - y.seq);

  return {
    nodes: [...nodes.values()],
    edges,
    width,
    height,
    cols: COLS.map((c, i) => ({ ...c, x: xs[i], present: present[i] || (i > 0 && i < 4 && board.links.length > 0) })),
    rows,
    divider,
    top,
  };
}

function spread(column: LNode[], gap: number, lo: number, hi: number) {
  if (column.length < 2) return;
  const sorted = [...column].sort((a, b) => a.y - b.y);
  const before = sorted.reduce((s, n) => s + n.y, 0) / sorted.length;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
  const after = sorted.reduce((s, n) => s + n.y, 0) / sorted.length;
  let shift = before - after;
  shift = Math.max(lo - sorted[0].y, Math.min(hi - sorted[sorted.length - 1].y, shift));
  for (const n of sorted) n.y += shift;
}

/** Edges and nodes upstream of a location, for highlighting its path back to the source. */
export function upstreamOf(layout: Layout, nodeId: string): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set([nodeId]);
  const edges = new Set<string>();
  let frontier = [nodeId];
  while (frontier.length) {
    const next: string[] = [];
    for (const e of layout.edges) {
      if (frontier.includes(e.b.id) && !edges.has(e.id)) {
        edges.add(e.id);
        if (!nodes.has(e.a.id)) {
          nodes.add(e.a.id);
          next.push(e.a.id);
        }
      }
    }
    frontier = next;
  }
  return { nodes, edges };
}
