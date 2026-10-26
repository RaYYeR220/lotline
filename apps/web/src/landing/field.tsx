// The crop-row field: a lettuce field drawn as lots, converging on the horizon.
// Dots drift toward the viewer on a 24 s loop; the pointer is a sampling probe
// that lifts nearby lots and reads their codes; a click lights one row back to
// the farm; one row lights itself shortly after load.

export interface FieldOptions {
  /** Element the field keeps clear behind (the claim); a soft mist is laid under it. */
  clearing?: () => HTMLElement | null;
  reduceMotion: boolean;
  coarsePointer: boolean;
}

const C = { lime: "#97c74b", leaf: "#2f4e37", cil: "#d8e0a5", deep: "#154726", tang: "#f1753f", oat: "#faf3e6" };
const K = 30; // rows either side of the centre row
const DZ = 0.105; // depth step between lots along a row
const ZN = 1;
const ZF = 15;
const SPEED = 8; // 8 rows of lots drift past every 24 s

const FARMS = ["Palomar Flats · Salinas", "Mesa Dorada · Yuma", "Tule Bend · Oxnard", "Halvard Cooling · Salinas"];

function hash(a: number, b: number) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const pad = (n: number, w = 2) => String(Math.abs(n) % 10 ** w).padStart(w, "0");
/** Lot codes in the grower format the demo world uses, e.g. GR12-26241-F3. */
const code = (k: number, j: number) => `GR${pad(12 + Math.floor(hash(k, 7) * 40))}-26${pad(200 + ((j % 60) + 60) % 60, 3)}-F${1 + Math.floor(hash(k, j) * 4)}`;

interface Trace {
  k: number;
  jg: number;
  t: number;
  from: string;
  to: string;
}

export function mountField(canvas: HTMLCanvasElement, host: HTMLElement, opts: FieldOptions): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const reduce = opts.reduceMotion;
  let W = 0, H = 0, hy = 0, vx = 0, gap = 74, dpr = 1;
  let clear = { x: 0, y: 0, rx: 0, ry: 0, box: null as DOMRect | null };
  const probe = { on: false, x: 0, y: 0 };
  const traces: Trace[] = [];
  const t0 = performance.now();
  let raf = 0;
  let visible = true;
  let stopped = false;

  function resize() {
    const r = host.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.round(r.width);
    H = Math.round(r.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    hy = Math.round(H * (W < 640 ? 0.3 : 0.315));
    vx = W / 2;
    gap = W < 640 ? 46 : 74;
    const el = opts.clearing?.();
    if (el) {
      const b = el.getBoundingClientRect();
      const box = new DOMRect(b.left - r.left, b.top - r.top, b.width, b.height);
      clear = { x: box.x + box.width / 2, y: box.y + box.height / 2, rx: box.width * 0.64, ry: box.height * 0.8, box };
    }
  }

  const shiftAt = (now: number) => (reduce ? 0 : ((now - t0) / 24000) * SPEED);

  function inClearing(x: number, y: number) {
    const b = clear.box;
    return !!b && x > b.left - 12 && x < b.right + 12 && y > b.top - 12 && y < b.bottom + 12;
  }

  function ignite(x: number, y: number, now: number, auto = false) {
    const d = (y - hy) / (H - hy);
    if (d < 0.04) return;
    const s = shiftAt(now), base = Math.floor(s), frac = s - base;
    const k = Math.round((x - vx) / (gap * d)), Z = ZN / d, j = Math.round((Z - ZN) / DZ + frac);
    traces.push({
      k, jg: j + base, t: now,
      from: auto ? "ST23 · Corner Basket #17 · L32611443" : `${code(k, j + base)} · sampled`,
      to: auto ? "Palomar Flats Farms · harvest 29 Aug" : FARMS[((k % 4) + 4) % 4],
    });
    if (traces.length > 3) traces.shift();
  }

  function pill(x: number, y: number, text: string, o: { bold?: boolean; fill?: string; stroke?: string; ink?: string } = {}) {
    ctx!.font = `${o.bold ? "600" : "500"} 11px "Figtree Variable", Figtree, sans-serif`;
    const w = ctx!.measureText(text).width + 14, h = 20, r = 4;
    if (x + w > W - 8) x = W - 8 - w;
    if (x < 8) x = 8;
    ctx!.beginPath();
    if ("roundRect" in ctx!) ctx!.roundRect(x, y - h / 2, w, h, r);
    else ctx!.rect(x, y - h / 2, w, h);
    ctx!.fillStyle = o.fill ?? "rgba(250,243,230,.94)";
    ctx!.fill();
    ctx!.lineWidth = 1;
    ctx!.strokeStyle = o.stroke ?? "rgba(21,71,38,.22)";
    ctx!.stroke();
    ctx!.fillStyle = o.ink ?? C.deep;
    ctx!.textBaseline = "middle";
    ctx!.fillText(text, x + 7, y + 0.5);
  }

  function draw(now: number) {
    const c = ctx!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    // earth, deepening toward the viewer
    const g = c.createLinearGradient(0, hy, 0, H);
    g.addColorStop(0, "rgba(243,237,209,0)");
    g.addColorStop(0.55, "rgba(216,224,165,.38)");
    g.addColorStop(1, "rgba(151,199,75,.30)");
    c.fillStyle = g;
    c.fillRect(0, hy, W, H - hy);

    // the rows themselves: 1px furrows converging on the vanishing point
    c.lineWidth = 1;
    c.beginPath();
    for (let k = -K; k <= K; k++) {
      c.moveTo(vx, hy);
      c.lineTo(vx + (k + 0.5) * gap, H);
    }
    const fg = c.createLinearGradient(0, hy, 0, H);
    fg.addColorStop(0, "rgba(47,78,55,0)");
    fg.addColorStop(0.25, "rgba(47,78,55,.08)");
    fg.addColorStop(1, "rgba(47,78,55,.16)");
    c.strokeStyle = fg;
    c.stroke();
    c.fillStyle = "rgba(21,71,38,.42)";
    c.fillRect(0, hy, W, 1); // 1px horizon rule

    const s = shiftAt(now), base = Math.floor(s), frac = s - base, R = W < 640 ? 84 : 120;
    const near: { x: number; y: number; dist: number; k: number; j: number }[] = [];
    const fronts: Record<number, { zs: number; zf: number; p: number; tr: Trace }> = {};
    for (const tr of traces) {
      let p = reduce ? 1 : Math.min(1, (now - tr.t) / 1900);
      p = 1 - Math.pow(1 - p, 3);
      const zs = ZN + (tr.jg - base - frac) * DZ;
      fronts[tr.k] = { zs, zf: zs + (ZF - zs) * p, p, tr };
    }
    const jmax = Math.ceil((ZF - ZN) / DZ) + 2;
    const probing = probe.on && !inClearing(probe.x, probe.y);

    // far to near so near dots paint on top
    for (let j = jmax; j >= -1; j--) {
      const Zr = ZN + (j - frac) * DZ;
      if (Zr < ZN * 0.9) continue;
      const jg = j + base;
      for (let k = -K; k <= K; k++) {
        // heads are planted by hand: a little slack along and across the row
        const f = fronts[k], isLit = !!f && Zr >= f.zs - 1e-6 && Zr <= f.zf;
        const Z = isLit ? Zr : Zr + (hash(k * 5 + 3, jg) - 0.5) * DZ * 0.5, d = ZN / Z, fade = Math.min(1, 0.18 + d * 1.6);
        const x = vx + (k + (isLit ? 0 : (hash(k * 3 + 1, jg) - 0.5) * 0.16)) * gap * d;
        if (x < -12 || x > W + 12) continue;
        let y = hy + (H - hy) * d;
        if (y > H + 12) continue;
        let r = Math.max(0.6, 5.6 * d);
        const h = hash(k, jg);
        let col = h < 0.26 ? C.leaf : h < 0.38 ? C.cil : C.lime;
        if (probing) {
          const dx = x - probe.x, dy = y - probe.y, dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < R) {
            const q = 1 - dist / R;
            y -= q * q * 22 * (0.4 + d);
            r *= 1 + 0.9 * q;
            if (d > 0.12) near.push({ x, y, dist, k, j: jg });
          }
        }
        c.globalAlpha = fade;
        if (isLit) {
          c.globalAlpha = 0.22;
          c.fillStyle = C.tang;
          c.beginPath();
          c.arc(x, y, r * 2.4, 0, 6.2832);
          c.fill();
          c.globalAlpha = 1;
          col = C.tang;
          r *= 1.12;
        }
        c.fillStyle = col;
        if (r < 1.3) c.fillRect(x - r, y - r, r * 2, r * 2);
        else {
          c.beginPath();
          c.arc(x, y, r, 0, 6.2832);
          c.fill();
        }
      }
    }
    c.globalAlpha = 1;

    // trace paths: one row lit from the sampled lot to the horizon
    const ends: { tr: Trace; xs: number; ys: number; xf: number; yf: number; p: number }[] = [];
    for (const tr of traces) {
      const f = fronts[tr.k];
      if (!f) continue;
      const ds = ZN / Math.max(f.zs, ZN * 0.9), df = ZN / f.zf;
      const xs = vx + tr.k * gap * ds, ys = hy + (H - hy) * ds, xf = vx + tr.k * gap * df, yf = hy + (H - hy) * df;
      c.strokeStyle = C.tang;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(xs, ys);
      c.lineTo(xf, yf);
      c.stroke();
      ends.push({ tr, xs, ys, xf, yf, p: f.p });
    }

    // a morning mist lies over the field where the claim stands
    if (clear.rx > 0) {
      c.save();
      c.translate(clear.x, clear.y);
      c.scale(1, clear.ry / clear.rx);
      const mg = c.createRadialGradient(0, 0, 0, 0, 0, clear.rx);
      mg.addColorStop(0, "rgba(250,243,230,.97)");
      mg.addColorStop(0.55, "rgba(250,243,230,.9)");
      mg.addColorStop(1, "rgba(250,243,230,0)");
      c.fillStyle = mg;
      c.fillRect(-clear.rx, -clear.rx, clear.rx * 2, clear.rx * 2);
      c.restore();
    }

    const last = traces[traces.length - 1];
    for (const e of ends) {
      if (e.tr !== last) continue;
      if (e.ys < H - 8) pill(e.xs + 14, e.ys - 4, e.tr.from, { bold: true, fill: C.deep, stroke: C.deep, ink: C.oat });
      if (e.p > 0.98) {
        c.fillStyle = C.tang;
        c.beginPath();
        c.arc(e.xf, e.yf, 3.5, 0, 6.2832);
        c.fill();
        pill(e.xf + 10, e.yf - 16, e.tr.to, { bold: true, stroke: "rgba(241,117,63,.6)" });
      }
    }

    // the probe: nearby lots lift and show their codes
    if (probing) {
      c.setLineDash([3, 4]);
      c.strokeStyle = "rgba(21,71,38,.4)";
      c.lineWidth = 1;
      c.beginPath();
      c.arc(probe.x, probe.y, R * 0.42, 0, 6.2832);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = C.tang;
      c.beginPath();
      c.arc(probe.x, probe.y, 2.5, 0, 6.2832);
      c.fill();
      near.sort((a, b) => a.dist - b.dist);
      near
        .slice(0, 3)
        .sort((a, b) => a.x - b.x)
        .forEach((n, i) => {
          const lx = probe.x + R * 0.55, ly = probe.y - R * 0.55 - i * 26;
          c.strokeStyle = "rgba(21,71,38,.45)";
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(n.x, n.y);
          c.lineTo(lx, ly);
          c.stroke();
          c.fillStyle = C.deep;
          c.beginPath();
          c.arc(n.x, n.y, 1.8, 0, 6.2832);
          c.fill();
          pill(lx, ly, code(n.k, n.j));
        });
    }
  }

  const frame = (now: number) => {
    raf = 0;
    if (stopped) return;
    draw(now);
    if (!reduce && visible) raf = requestAnimationFrame(frame);
  };
  const redraw = () => {
    if (reduce || !visible) draw(performance.now());
  };
  const resume = () => {
    if (!reduce && visible && !raf && !stopped) raf = requestAnimationFrame(frame);
  };

  const local = (e: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onMove = (e: PointerEvent) => {
    const p = local(e);
    probe.on = p.y > hy - 6 && p.y < H;
    probe.x = p.x;
    probe.y = p.y;
    redraw();
  };
  const onLeave = () => {
    probe.on = false;
    redraw();
  };
  const onClick = (e: MouseEvent) => {
    const p = local(e);
    if (inClearing(p.x, p.y)) return;
    ignite(p.x, p.y, performance.now());
    redraw();
  };
  const onResize = () => {
    resize();
    redraw();
  };

  host.addEventListener("pointermove", onMove, { passive: true });
  host.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);
  const ro = new ResizeObserver(onResize);
  ro.observe(host);
  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) resume();
  });
  io.observe(host);

  resize();
  // the recall lights one row on its own, so the idea reads before anyone clicks
  const autoTimer = window.setTimeout(
    () => {
      ignite(vx + 2 * gap * 0.8, hy + (H - hy) * 0.8, performance.now(), true);
      redraw();
    },
    reduce ? 0 : 1300,
  );
  if (reduce) draw(performance.now());
  else resume();

  return () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(autoTimer);
    ro.disconnect();
    io.disconnect();
    host.removeEventListener("pointermove", onMove);
    host.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("click", onClick);
  };
}
