import type { ActionKind, Approval } from "../lib/types.tsx";
import type { LEdge } from "./layout.tsx";

export type EdgeStatus = "proposed" | "proven" | "contested" | "unproven" | "rejected" | "ghost";

export const STATUS_LABEL: Record<EdgeStatus, string> = {
  proposed: "proposed",
  proven: "proven",
  contested: "contested",
  unproven: "unproven",
  rejected: "rejected",
  ghost: "different lot",
};

export function edgeStatus(e: LEdge): EdgeStatus {
  if (e.ghost) return "ghost";
  return e.link!.status;
}

/** A shape per action, so the action never rests on colour alone. */
export const ACTION_GLYPH: Record<ActionKind, string> = {
  PULL: "▲",
  HOLD: "■",
  CLEAR: "✓",
  ESCALATE: "◆",
};

export const ACTION_LABEL: Record<ActionKind, string> = {
  PULL: "Pull from sale",
  HOLD: "Hold, pending proof",
  CLEAR: "Clear, proven unaffected",
  ESCALATE: "Escalate to a person",
};

export const APPROVAL_LABEL: Record<Approval, string> = {
  "not-required": "No approval needed",
  pending: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
};

export const STATUS_CHIP: Record<string, string> = {
  success: "ok",
  needs_revision: "challenged",
  retry: "retry",
  escalated: "escalated",
  error: "error",
  skipped: "skipped",
};
