/**
 * Lotline policy pack: the action gate for recall decisions.
 *
 * Every PULL / HOLD / CLEAR / ESCALATE / NOTIFY the ActionPlanner proposes becomes an
 * execution contract here, and nothing downstream acts without one. The rules:
 *
 *   - any untrusted partner text (notes, BOL text, emails) that the injection guard flags
 *     refuses the contract outright; flagged text is never acted on and never echoed back
 *   - CLEAR needs at least one proven negative-evidence link, cited on the contract
 *   - PULL and NOTIFY are high risk and wait for a human approval
 *   - HOLD (medium) and ESCALATE (low) go straight through: both are the safe direction
 *
 * signature = HMAC-SHA256(secret, canonical JSON of every field except `signature`).
 */
import { canonicalJson, hmacHex, sameSignature, ulid, withoutSignature } from "./contract.ts";
import { composePacks } from "./packs.ts";
import { scanInjection } from "./risk.ts";

export type RecallIntent = "pull" | "hold" | "clear" | "escalate" | "notify";

export interface ExecutionContract {
  id: string;
  intent: RecallIntent;
  target: string;
  args: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
  evidenceLinkIds: string[];
  issuedAt: string;
  signature: string;
}

export interface ContractRequest {
  intent: RecallIntent;
  /** Location (or lot) the action applies to. */
  target: string;
  args: Record<string, unknown>;
  /** Trace links the action rests on; cited on the contract. */
  evidenceLinkIds: string[];
  /** How many of those links are proven (for CLEAR: proven negative evidence). */
  provenEvidenceCount: number;
  /** Partner-supplied text that informed the decision. Data, never instructions. */
  untrustedText?: string[];
}

export interface ContractRefusal {
  refused: true;
  reason: "no-evidence" | "injection" | "policy";
  detail: string;
}

export const RECALL_POLICY: Record<RecallIntent, { risk: ExecutionContract["risk"]; requiresApproval: boolean }> = {
  pull: { risk: "high", requiresApproval: true },
  notify: { risk: "high", requiresApproval: true },
  clear: { risk: "medium", requiresApproval: false },
  hold: { risk: "medium", requiresApproval: false },
  escalate: { risk: "low", requiresApproval: false },
};

/** Untrusted text is judged by the default pack plus the Lotline recall-directive patterns. */
const UNTRUSTED = composePacks(["default", "lotline"]);

/** Injection guard for partner data. Returns pattern ids as signals, never the matched text. */
export function scanUntrusted(text: string): { flagged: boolean; score: number; signals: string[] } {
  const scan = scanInjection(text, UNTRUSTED, "snippet");
  return { flagged: scan.score >= UNTRUSTED.snippetBlockAt, score: scan.score, signals: scan.matches.map((m) => m.id) };
}

const refuse = (reason: ContractRefusal["reason"], detail: string): ContractRefusal => ({ refused: true, reason, detail });
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function issueContract(req: ContractRequest, secret: string, opts: { now?: Date } = {}): ExecutionContract | ContractRefusal {
  if (!secret) throw new Error("issueContract: a signing secret is required");

  // 1. Injection: one flagged note refuses the whole action.
  for (const [i, text] of (req.untrustedText ?? []).entries()) {
    if (typeof text !== "string") return refuse("policy", `untrustedText[${i}] is not a string`);
    const scan = scanUntrusted(text);
    if (scan.flagged) {
      return refuse("injection", `untrustedText[${i}] flagged by the injection guard (score ${scan.score}: ${scan.signals.join(", ")}); the text was not acted on`);
    }
  }

  // 2. Policy: only well-formed requests for known recall actions.
  const rule = RECALL_POLICY[req.intent];
  if (!rule) return refuse("policy", `unknown recall intent "${String(req.intent)}"`);
  if (typeof req.target !== "string" || !req.target.trim()) return refuse("policy", "target is required");
  if (!isPlainObject(req.args)) return refuse("policy", "args must be an object");
  if (!Array.isArray(req.evidenceLinkIds) || req.evidenceLinkIds.some((id) => typeof id !== "string" || !id.trim())) {
    return refuse("policy", "evidenceLinkIds must be non-empty strings");
  }
  if (!Number.isInteger(req.provenEvidenceCount) || req.provenEvidenceCount < 0) return refuse("policy", "provenEvidenceCount must be a non-negative integer");

  // 3. Evidence: CLEAR is the one action that can never be taken on absence of proof,
  //    and the proof has to be cited on the contract, not just counted.
  if (req.intent === "clear" && (req.provenEvidenceCount === 0 || req.evidenceLinkIds.length === 0)) {
    return refuse("no-evidence", `clear for ${req.target} needs at least one proven negative-evidence link; hold or escalate instead`);
  }
  if (req.provenEvidenceCount > req.evidenceLinkIds.length) {
    return refuse("policy", `claims ${req.provenEvidenceCount} proven links but cites ${req.evidenceLinkIds.length}`);
  }

  const now = opts.now ?? new Date();
  const unsigned: Omit<ExecutionContract, "signature"> = {
    id: `lc_${ulid(now.getTime())}`,
    intent: req.intent,
    target: req.target.trim(),
    args: req.args,
    risk: rule.risk,
    requiresApproval: rule.requiresApproval,
    evidenceLinkIds: [...req.evidenceLinkIds],
    issuedAt: now.toISOString(),
  };
  return { ...unsigned, signature: hmacHex(secret, canonicalJson(unsigned)) };
}

/** True only for an untampered contract signed with this secret. */
export function verifyContract(c: ExecutionContract, secret: string): boolean {
  if (!c || typeof c !== "object" || typeof c.signature !== "string" || !/^[0-9a-f]{64}$/.test(c.signature) || !secret) return false;
  try {
    return sameSignature(hmacHex(secret, canonicalJson(withoutSignature(c))), c.signature);
  } catch {
    return false;
  }
}
