/**
 * Route: intents declare abstract capabilities; the capability graph resolves each one to a
 * concrete tool at decision time.
 *
 * Selection, in priority order:
 *   1. permissions   drop tools the user cannot use
 *   2. availability  drop tools that are offline (or named as failed by a re-plan)
 *   3. surface       tools that prefer the current surface first
 *   4. cost          cheapest tool within the latency budget
 *   5. tie-break     local before remote, explicitly registered before built-in defaults
 *
 * Capabilities can depend on others (swarm.run needs memory.recall and markovian.chain); the
 * router walks those edges and adds the dependencies to the plan. A capability with no usable
 * tool is reported as a typed outcome; Scout never substitutes something out of scope.
 */
import type { Intent, ToolRegistration, ToolStep, UnresolvedCapability, UserRef } from "./types.ts";

/** Built-in adapters for the canonical capabilities, so a bare registry routes out of the box. */
export const DEFAULT_TOOLS: ToolRegistration[] = [
  { capability: "world.query", toolId: "meterless.world-model.graph", local: true, cost: { perCall: 0 }, latency: { p95Ms: 50 } },
  { capability: "world.assert", toolId: "meterless.world-model.assert", local: true, cost: { perCall: 0 }, latency: { p95Ms: 50 } },
  { capability: "memory.recall", toolId: "meterless.hmem.retrieve", local: true, cost: { perCall: 0 }, latency: { p95Ms: 80 } },
  { capability: "memory.commit", toolId: "meterless.hmem.commit", local: true, cost: { perCall: 0 }, latency: { p95Ms: 80 } },
  { capability: "swarm.run", toolId: "meterless.swarm.execute", local: true, cost: { perCall: 0 }, latency: { p95Ms: 8000 } },
  { capability: "markovian.chain", toolId: "meterless.markovian.chain", local: true, cost: { perCall: 0 }, latency: { p95Ms: 6000 } },
  { capability: "email.draft", toolId: "local.email.drafter", local: true, cost: { perCall: 0 }, latency: { p95Ms: 200 } },
  { capability: "email.send", toolId: "smtp.send", local: false, cost: { perCall: 0 }, latency: { p95Ms: 800 }, surfaces: ["chat", "inbox"] },
  { capability: "calendar.create", toolId: "local.calendar.create", local: true, cost: { perCall: 0 }, latency: { p95Ms: 100 } },
  { capability: "approval.require", toolId: "scout.approval.gate", local: true, cost: { perCall: 0 }, latency: { p95Ms: 10 } },
];

/** Capabilities composed of others; the router follows these transitively. */
export const CAPABILITY_DEPENDENCIES: Record<string, string[]> = {
  "swarm.run": ["memory.recall", "markovian.chain"],
};

/** Families let policy reason about whole classes of behaviour. */
export const CAPABILITY_FAMILIES: Record<string, string[]> = {
  read: ["world.query", "memory.recall", "file.read"],
  write: ["world.assert", "memory.commit", "file.write"],
  reason: ["swarm.run", "markovian.chain"],
  act: ["email.send", "calendar.create", "slack.post", "approval.require"],
  compose: ["email.draft"],
};

export class ScoutError extends Error {
  constructor(
    readonly code: "capability_unavailable" | "unknown_intent" | "unknown_contract" | "invalid_contract",
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ScoutError";
  }
}

export interface RouteContext {
  user: UserRef;
  surface: string;
  /** Latency target for any single step, if the caller set one. */
  latencyBudgetMs?: number;
  /** Tool ids reported failed by a re-plan. */
  unavailable?: Set<string>;
}

interface Entry {
  reg: ToolRegistration;
  builtin: boolean;
  order: number;
}

export class CapabilityGraph {
  private readonly entries: Entry[] = [];
  private order = 0;

  constructor(opts: { defaults?: boolean } = {}) {
    if (opts.defaults !== false) for (const t of DEFAULT_TOOLS) this.entries.push({ reg: t, builtin: true, order: this.order++ });
  }

  /** Register (or replace, by capability + toolId) a concrete tool for a capability. */
  register(reg: ToolRegistration): void {
    const i = this.entries.findIndex((e) => e.reg.capability === reg.capability && e.reg.toolId === reg.toolId);
    const entry = { reg, builtin: false, order: this.order++ };
    if (i >= 0) this.entries[i] = entry;
    else this.entries.push(entry);
  }

  /** Every capability and tool id this deployment knows; used by the out-of-band tool check. */
  knows(id: string): boolean {
    const lower = id.toLowerCase();
    return this.entries.some((e) => e.reg.capability.toLowerCase() === lower || e.reg.toolId.toLowerCase() === lower);
  }

  toolIds(): string[] {
    return this.entries.map((e) => e.reg.toolId);
  }

  resolve(capability: string, ctx: RouteContext): { tool?: ToolRegistration; error?: UnresolvedCapability["error"] } {
    const all = this.entries.filter((e) => e.reg.capability === capability);
    if (!all.length) return { error: "no_adapter" };
    const held = new Set(ctx.user.permissions ?? []);
    const permitted = all.filter((e) => (e.reg.requiredPermissions ?? []).every((p) => held.has(p)));
    if (!permitted.length) return { error: "permission" };
    const live = permitted.filter(
      (e) =>
        !ctx.unavailable?.has(e.reg.toolId) &&
        (e.reg.availability?.() ?? true) &&
        (ctx.latencyBudgetMs === undefined || (e.reg.latency?.p95Ms ?? 0) <= ctx.latencyBudgetMs),
    );
    if (!live.length) return { error: "unavailable" };
    const prefers = (e: Entry) => (e.reg.surfaces?.includes(ctx.surface) ? 0 : 1);
    live.sort(
      (a, b) =>
        prefers(a) - prefers(b) ||
        (a.reg.cost?.perCall ?? 0) - (b.reg.cost?.perCall ?? 0) ||
        Number(b.reg.local ?? false) - Number(a.reg.local ?? false) ||
        Number(a.builtin) - Number(b.builtin) ||
        a.order - b.order,
    );
    return { tool: live[0]!.reg };
  }

  /** Assemble the ordered tool plan for one or more intents (in execution order). */
  plan(intents: { intent: Intent; parameters: Record<string, unknown> }[], ctx: RouteContext): { steps: ToolStep[]; unresolved: UnresolvedCapability[] } {
    const steps: ToolStep[] = [];
    const unresolved: UnresolvedCapability[] = [];
    const planned = new Set<string>();

    const place = (capability: string, intent: Intent, parameters: Record<string, unknown>, requiredBy?: string) => {
      if (planned.has(capability)) return false;
      planned.add(capability);
      const r = this.resolve(capability, ctx);
      if (r.tool) {
        steps.push({
          step: steps.length + 1,
          capability,
          tool: r.tool.toolId,
          fromIntent: intent.id,
          ...(requiredBy ? { requiredBy } : {}),
          input: requiredBy ? {} : { ...parameters },
          local: r.tool.local ?? false,
          modelProfile: null,
        });
      } else {
        // A missing direct capability fails routing; a missing transitive one degrades the plan.
        unresolved.push({ capability, fromIntent: intent.id, error: r.error!, severity: requiredBy ? "warn" : "error" });
      }
      return true;
    };
    const dependencies = (capability: string, intent: Intent, parameters: Record<string, unknown>) => {
      for (const dep of CAPABILITY_DEPENDENCIES[capability] ?? []) {
        if (place(dep, intent, parameters, capability)) dependencies(dep, intent, parameters);
      }
    };

    // Each intent's own capabilities first (in declared order), then what they pull in.
    for (const { intent, parameters } of intents) {
      for (const cap of intent.capabilities) place(cap, intent, parameters);
      for (const cap of intent.capabilities) dependencies(cap, intent, parameters);
    }
    return { steps, unresolved };
  }
}
