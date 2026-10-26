import type { LotStyle } from "./catalog.ts";
import { yyddd, yymmdd } from "./dates.ts";

/**
 * Lot-code conventions of each partner system. The same physical lot is
 * written differently by each company; that drift is part of the world.
 *
 *   grower      GR{farm}-{yyddd}-{field}     GR12-26245-F3
 *   packer      PK{yyMMdd}{seq3}             PK260905012
 *   WMS         PK-{yyMMdd}-{seq3}           PK-260905-012   (dash drift)
 *   retail      {chain}:{lot, no separators} HBR:PK260905012, ppg:pk260905012, CBK:PK26090501
 */

export function growerLot(farmCode: string, harvestIso: string, fieldId: string): string {
  return `GR${farmCode}-${yyddd(harvestIso)}-${fieldId}`;
}

export function packerLot(packIso: string, seq: number): string {
  return `PK${yymmdd(packIso)}${String(seq).padStart(3, "0")}`;
}

/** How Northgate's WMS keys in a packer lot from the case label. */
export function wmsVendorLot(packerCode: string): string {
  const m = /^PK(\d{6})(\d{3})$/.exec(packerCode);
  if (!m) return packerCode;
  return `PK-${m[1]}-${m[2]}`;
}

/** Lot codes of the direct (non-produce) vendors, each in its own house format. */
export function directVendorLot(vendorId: string, madeIso: string, n: number): string {
  switch (vendorId) {
    case "ARC": return `AR${yymmdd(madeIso)}Q${n}`;
    case "SER": return `P2187-${yyddd(madeIso)}`;
    case "CSS": return `CSS-${yymmdd(madeIso)}-${String(n).padStart(2, "0")}`;
    default: throw new Error(`unknown vendor ${vendorId}`);
  }
}

/** Number of lot characters a truncating retail system keeps. */
export const RETAIL_TRUNCATE_AT = 10;

/** Retail receiving systems store `{chain}:{lot}` with separators stripped, in the chain's own style. */
export function retailRefLot(chainId: string, style: LotStyle, lot: string): string {
  const stripped = lot.replace(/[^A-Za-z0-9]/g, "");
  switch (style) {
    case "plain": return `${chainId}:${stripped}`;
    case "lower": return `${chainId}:${stripped}`.toLowerCase();
    case "truncate": return `${chainId}:${stripped.slice(0, RETAIL_TRUNCATE_AT)}`;
  }
}

/**
 * Exact lot identity: upper-case, separators removed. Two codes name the same
 * lot iff their canonical forms are equal. Truncated retail codes are *not*
 * resolvable this way — they can only narrow the candidates.
 */
export function canonicalLot(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Number of positions at which two equal-length codes differ (Infinity if lengths differ). */
export function charDistance(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}
