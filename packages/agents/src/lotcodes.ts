// Deterministic lot-code handling. Models may suggest that two codes are the same lot;
// these rules decide what counts as the same code before any model is asked.

const PACKER = /^PK[-\s]?(\d{6})[-\s]?0*(\d{1,3})$/i;

/** One canonical spelling per physical lot code across partner systems. */
export function canonicalLot(code: string): string {
  let c = code.trim();
  const colon = c.lastIndexOf(":");
  if (colon >= 0) c = c.slice(colon + 1);
  c = c.replace(/\s+/g, " ").toUpperCase();
  const packer = c.replace(/\s/g, "-").match(PACKER) ?? c.replace(/[\s-]/g, "").match(/^PK(\d{6})(\d{1,3})$/);
  if (packer) return `PK${packer[1]}${packer[2].padStart(3, "0")}`;
  return c.replace(/\s+/g, "-");
}

export function lotDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[n];
}

export type LotMatch =
  | { kind: "exact"; distance: 0 }
  | { kind: "truncated"; distance: number }
  | { kind: "near"; distance: number }
  | { kind: "none"; distance: number };

/**
 * How a code seen in one system relates to a known lot:
 * exact after canonicalisation, a retail truncation (prefix of at least 10 characters),
 * a near miss (edit distance 1–2: a possible decoy or typo that must be corroborated), or none.
 */
export function matchLot(known: string, seen: string): LotMatch {
  const a = canonicalLot(known);
  const raw = seen.includes(":") ? seen.slice(seen.lastIndexOf(":") + 1) : seen;
  const b = canonicalLot(seen);
  if (a === b) return { kind: "exact", distance: 0 };
  const stripped = raw.replace(/[\s-]/g, "").toUpperCase();
  const aFlat = a.replace(/-/g, "");
  if (stripped.length >= 10 && stripped.length < aFlat.length && aFlat.startsWith(stripped)) {
    return { kind: "truncated", distance: aFlat.length - stripped.length };
  }
  const d = lotDistance(aFlat, b.replace(/-/g, ""));
  if (d <= 2 && Math.min(aFlat.length, b.length) >= 6) return { kind: "near", distance: d };
  return { kind: "none", distance: d };
}
