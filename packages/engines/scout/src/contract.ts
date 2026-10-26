/**
 * Contract plumbing shared by the Scout engine and the Lotline policy pack:
 * canonical JSON, HMAC-SHA256 signing, verification and monotonic ULIDs.
 *
 * signature = HMAC_SHA256(secret, canonical_json(contract without `signature`))
 *
 * HMAC over the canonical encoding is an integrity check between our own modules (it
 * catches mutation in transit, hand-built plans and replays past expiry), not a
 * multi-party signature scheme.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApprovalSpec, ScoutContract } from "./types.ts";

/** JSON with object keys sorted at every depth; undefined members are dropped, like JSON.stringify. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortKeys(v)));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time comparison of two signature strings. */
export function sameSignature(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function withoutSignature<T extends { signature?: unknown }>(c: T): Omit<T, "signature"> {
  const { signature: _drop, ...rest } = c;
  return rest;
}

// ---------------------------------------------------------------------------
// Monotonic ULIDs (Crockford base32: 48-bit time + 80-bit randomness)
// ---------------------------------------------------------------------------

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRandom: number[] = [];

export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    // Same millisecond (or clock went back): increment the random part so ids stay ordered.
    now = lastTime;
    let i = lastRandom.length - 1;
    while (i >= 0 && lastRandom[i] === 31) lastRandom[i--] = 0;
    if (i >= 0) lastRandom[i]!++;
  } else {
    lastTime = now;
    lastRandom = [...randomBytes(16)].map((b) => b % 32);
  }
  let time = "";
  for (let t = now, k = 0; k < 10; k++, t = Math.floor(t / 32)) time = B32[t % 32] + time;
  return time + lastRandom.map((d) => B32[d]).join("");
}

// ---------------------------------------------------------------------------
// Scout execution contracts
// ---------------------------------------------------------------------------

export function signScoutContract(unsigned: Omit<ScoutContract, "signature">, secret: string): ScoutContract {
  return { ...unsigned, signature: `hmac-sha256:${hmacHex(secret, canonicalJson(unsigned))}` };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "missing-approval" | "rejected" };

/**
 * What a downstream engine runs at its boundary before acting:
 *   1. recompute the HMAC over the canonical JSON (minus signature)
 *   2. now < expiresAt
 *   3. every required approval is present (and none rejected)
 * Only then may it run the tools listed in scope.capabilities.
 */
export function verifyScoutContract(
  contract: ScoutContract,
  opts: { secret: string; now?: Date; requireApprovals?: boolean },
): VerifyResult {
  if (!contract || typeof contract !== "object" || typeof contract.signature !== "string" || !contract.signature.startsWith("hmac-sha256:")) {
    return { ok: false, reason: "malformed" };
  }
  let expected: string;
  try {
    expected = `hmac-sha256:${hmacHex(opts.secret, canonicalJson(withoutSignature(contract)))}`;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!sameSignature(expected, contract.signature)) return { ok: false, reason: "bad-signature" };
  const now = (opts.now ?? new Date()).getTime();
  if (!(now < Date.parse(contract.expiresAt))) return { ok: false, reason: "expired" };
  const approvals = contract.risk?.approvals ?? [];
  if (approvals.some((a) => a.decision === "reject")) return { ok: false, reason: "rejected" };
  if (opts.requireApprovals !== false) {
    const missing = (contract.risk?.approvalsRequired ?? []).some(
      (req: ApprovalSpec) => !approvals.some((a) => a.kind === req.kind && a.decision === "approve"),
    );
    if (missing) return { ok: false, reason: "missing-approval" };
  }
  return { ok: true };
}
