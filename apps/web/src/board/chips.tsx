import type { ActionKind } from "../lib/types.tsx";
import { parseModel } from "./derive.tsx";
import { ACTION_GLYPH } from "./status.tsx";

/** Which model served a step. Nemotron ids up front; replays and the rule fallback say so. */
export function ModelChip({ model, compact = false }: { model: string | null; compact?: boolean }) {
  const m = parseModel(model);
  if (!m) return null;
  if (m.rules) {
    return (
      <span className="model-chip is-rules" title="No model answered; the deterministic rule did">
        rules · fallback
      </span>
    );
  }
  const name = compact ? m.label.replace(/^nemotron-/, "") : m.label;
  return (
    <span className={`model-chip${m.vendor === "nvidia" ? " is-nvidia" : ""}`} title={model ?? ""}>
      {m.vendor && <span className="model-vendor">{m.vendor === "nvidia" ? "NVIDIA" : m.vendor}</span>}
      <span className="model-name">{name}</span>
      {m.replay && <span className="model-replay">replay</span>}
    </span>
  );
}

export function ActionChip({ kind, size = "md" }: { kind: ActionKind; size?: "sm" | "md" }) {
  return (
    <span className={`action-chip a-${kind.toLowerCase()} size-${size}`}>
      <span aria-hidden="true">{ACTION_GLYPH[kind]}</span>
      {kind}
    </span>
  );
}
