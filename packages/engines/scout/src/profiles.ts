/**
 * Recommend: pick a model profile per task in the plan.
 *
 *   1. compatibility  the profile supports what the task needs (json-mode, function-calling, ...)
 *   2. data class     the profile is cleared for the input's data class
 *   3. context        the profile fits the estimated prompt
 *   4. cost           under the caller's budget, when one is set
 *   5. quality        high-risk work prefers high-quality profiles
 * Candidates are tried in chain order (local-first by default); the survivors after the
 * first become its fallbacks, which obey the same data-class constraint.
 */
import { readFileSync } from "node:fs";
import type { Lane } from "@lotline/core";
import type { DataClass, Intent, ModelProfile, ModelProfileRef, ToolStep } from "./types.ts";

const ALL_CLASSES: DataClass[] = ["public", "internal", "confidential", "restricted"];

/** Generic local-first defaults; deployments replace the remote models with their own lanes. */
export const DEFAULT_PROFILES: ModelProfile[] = [
  { id: "local-fast", provider: "local", model: "local-fast", context: 32_000, cost: { in: 0, out: 0 }, latency: { p95Ms: 600 }, capabilities: ["text", "json-mode"], dataClasses: ALL_CLASSES, quality: "basic" },
  { id: "local-capable", provider: "local", model: "local-capable", context: 32_000, cost: { in: 0, out: 0 }, latency: { p95Ms: 4000 }, capabilities: ["text", "json-mode", "function-calling"], dataClasses: ALL_CLASSES, quality: "standard" },
  { id: "remote-fast", provider: "remote", model: "fast", context: 128_000, cost: { in: 0.0001, out: 0.0004 }, latency: { p95Ms: 800 }, capabilities: ["text", "json-mode", "function-calling"], dataClasses: ["public", "internal"], quality: "standard" },
  { id: "remote-capable", provider: "remote", model: "reason", context: 128_000, cost: { in: 0.003, out: 0.015 }, latency: { p95Ms: 2500 }, capabilities: ["text", "json-mode", "function-calling"], dataClasses: ["public", "internal"], quality: "high" },
];

export const CHAINS = {
  "local-first": ["local-fast", "local-capable", "remote-fast", "remote-capable"],
  "cloud-first": ["remote-fast", "remote-capable", "local-capable", "local-fast"],
} as const;
export type Routing = keyof typeof CHAINS;

/** Lotline: remote profiles are the Nightshift lanes pinned in @lotline/core config. */
export function lotlineProfiles(lanes: Record<Lane, string>): ModelProfile[] {
  const remote = (id: string, lane: Lane, quality: ModelProfile["quality"], latency: number): ModelProfile => ({
    id,
    provider: "nightshift",
    model: lanes[lane],
    context: 128_000,
    cost: { in: 0, out: 0 },
    latency: { p95Ms: latency },
    capabilities: ["text", "json-mode", "function-calling"],
    dataClasses: ["public", "internal", "confidential"],
    quality,
  });
  return [
    { ...DEFAULT_PROFILES[0]!, model: "rules" },
    remote("remote-fast", "fast", "standard", 1500),
    remote("remote-capable", "reason", "high", 6000),
    remote("remote-guard", "guard", "standard", 1500),
  ];
}

const QUALITY = { basic: 0, standard: 1, high: 2 } as const;

interface TaskNeed {
  capabilities: string[];
  quality: keyof typeof QUALITY;
  tokens: number;
}

/** What a model needs to do for each capability; null means the step runs without a model. */
function needFor(capability: string, intent: Intent): TaskNeed | null {
  const quality = intent.riskClass === "high" ? "high" : "standard";
  switch (capability) {
    case "swarm.run":
    case "markovian.chain":
      return { capabilities: ["text", "json-mode"], quality, tokens: 8000 };
    case "email.draft":
    case "email.send":
      return { capabilities: ["text"], quality, tokens: 3000 };
    case "world.query":
    case "world.assert":
    case "memory.recall":
    case "memory.commit":
    case "calendar.create":
    case "approval.require":
      return null;
    default:
      return { capabilities: ["text"], quality: "standard", tokens: 4000 };
  }
}

export class ModelRouter {
  readonly profiles: ModelProfile[];
  readonly routing: Routing;

  constructor(source?: string | ModelProfile[] | { profiles: ModelProfile[]; defaultChain?: Routing }, routing?: Routing) {
    let doc: { profiles: ModelProfile[]; defaultChain?: Routing };
    if (typeof source === "string") doc = JSON.parse(readFileSync(source, "utf8"));
    else if (Array.isArray(source)) doc = { profiles: source };
    else doc = source ?? { profiles: DEFAULT_PROFILES };
    this.profiles = doc.profiles;
    this.routing = routing ?? doc.defaultChain ?? "local-first";
  }

  private chain(): ModelProfile[] {
    const order: readonly string[] = CHAINS[this.routing];
    const rank = (p: ModelProfile) => {
      const i = order.indexOf(p.id);
      if (i >= 0) return i;
      // Unknown ids slot in by locality, after the named chain.
      const local = p.provider === "local";
      return order.length + ((this.routing === "local-first") === local ? 0 : 1);
    };
    return [...this.profiles].sort((a, b) => rank(a) - rank(b));
  }

  /** Choose for one task; quality is a preference, the other rules are hard filters. */
  choose(need: TaskNeed, dataClass: DataClass, budget?: { costMaxUSD?: number }): ModelProfileRef | null {
    const fits = this.chain().filter((p) => {
      if (!need.capabilities.every((c) => p.capabilities.includes(c))) return false;
      if (!p.dataClasses.includes(dataClass)) return false;
      if (p.context && p.context < need.tokens) return false;
      const cost = (need.tokens / 1000) * (p.cost.in + p.cost.out);
      return budget?.costMaxUSD === undefined || cost <= budget.costMaxUSD;
    });
    if (!fits.length) return null;
    const good = fits.filter((p) => QUALITY[p.quality ?? "standard"] >= QUALITY[need.quality]);
    const ordered = [...good, ...fits.filter((p) => !good.includes(p))];
    const [pick, ...rest] = ordered;
    return { id: pick!.id, provider: pick!.provider, model: pick!.model, fallbacks: pick!.fallbacks ?? rest.map((p) => p.id) };
  }

  /**
   * Assign a profile to every model-backed step and return the contract-level profile:
   * the one chosen for the most demanding task, or a light conversational profile when the
   * plan needs no model at all.
   */
  assign(steps: ToolStep[], intents: Map<string, Intent>, dataClass: DataClass, budget?: { costMaxUSD?: number }): ModelProfileRef | null {
    let best: { ref: ModelProfileRef; weight: number } | null = null;
    for (const step of steps) {
      const intent = intents.get(step.fromIntent);
      const need = intent ? needFor(step.capability, intent) : null;
      if (!need) continue;
      const ref = this.choose(need, dataClass, budget);
      step.modelProfile = ref?.id ?? null;
      const weight = QUALITY[need.quality] * 10_000 + need.tokens;
      if (ref && (!best || weight > best.weight)) best = { ref, weight };
    }
    return best?.ref ?? this.choose({ capabilities: ["text"], quality: "basic", tokens: 1000 }, dataClass, budget);
  }
}
