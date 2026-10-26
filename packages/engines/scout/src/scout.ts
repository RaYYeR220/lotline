/**
 * Scout: the decision layer that runs before every meaningful action.
 *
 *   Sense -> Interpret -> Guard -> Route -> Recommend -> signed execution contract
 *
 * Scout decides, guards, routes and signs; it never executes. Downstream engines act only
 * on a contract that verifies (signature, expiry, approvals) and only with the tools listed
 * in its scope. Everything here runs locally and deterministically; the optional Stage-2
 * hooks add a model lane without ever being required.
 */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { signScoutContract, ulid, verifyScoutContract, withoutSignature, type VerifyResult } from "./contract.ts";
import { bindParameters, clarify, executionModeOf, type Binding } from "./interpret.ts";
import { composePacks, type InjectionPattern, type PackSpec, type PolicyPack, type Threat } from "./packs.ts";
import { ModelRouter, type Routing } from "./profiles.ts";
import { IntentRegistry } from "./registry.ts";
import { GuardStack, type GuardIntent } from "./risk.ts";
import { CapabilityGraph, ScoutError } from "./route.ts";
import { BANDS, bandOf, runStage2, selfTest, sense, senseSpans, withTimeout, type SelfTestResult } from "./sense.ts";
import { analyze, type Analysis } from "./text.ts";
import type {
  ApprovalRecord,
  BoundIntent,
  Clarification,
  DataClass,
  DecideInput,
  Decision,
  ExecutionMode,
  GuardResult,
  Intent,
  IntentCandidate,
  ModelProfile,
  ModelProfileRef,
  RegistryDocument,
  RiskClass,
  ScoutContract,
  ScoutEvent,
  SessionContext,
  Stage2Hooks,
  ToolStep,
  UnresolvedCapability,
  UserRef,
} from "./types.ts";

export interface ScoutOptions {
  intentRegistry: string | IntentRegistry | RegistryDocument | Intent[];
  /** Named pack(s), pack objects or .json pack files, composed left to right. Default "default". */
  policyPack?: PackSpec;
  modelProfiles?: string | ModelProfile[] | { profiles: ModelProfile[]; defaultChain?: Routing };
  routing?: Routing;
  /** HMAC secret. Falls back to SCOUT_SECRET / CONTRACT_SECRET, then a per-instance random secret. */
  signingSecret?: string;
  stage2?: Stage2Hooks;
  /** Register the built-in adapters for canonical capabilities (default true). */
  defaultTools?: boolean;
  /** Contract time-to-live in ms (default 5 minutes). */
  ttlMs?: number;
  clock?: () => Date;
  onEvent?: (e: ScoutEvent) => void;
  /** Startup Stage-1 latency self-test: true (throw on failure, default), "warn", or false. */
  selfTest?: boolean | "warn";
}

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_REMEMBERED = 500;
const NO_PROFILE: ModelProfileRef = { id: "none", provider: "none", model: "none", fallbacks: [] };

interface Picked {
  intent: Intent;
  confidence: number;
  span?: string;
  start: number;
  fallbackFrom?: string;
}

/** Everything Sense + Interpret concluded about one request. */
interface Understanding {
  analysis: Analysis;
  candidates: IntentCandidate[];
  stage2: Decision["stage2"];
  primary: Picked;
  secondary: Picked[];
  multi: boolean;
  mode: ExecutionMode;
  bindings: Map<string, Binding>;
  clarification: Clarification | null;
}

interface Remembered {
  contract: ScoutContract;
  input: DecideInput;
  unavailable: Set<string>;
}

export class Scout {
  readonly registry: IntentRegistry;
  readonly capabilities: CapabilityGraph;
  readonly models: ModelRouter;
  readonly selfTest: SelfTestResult;
  readonly policy: { addInjectionPattern: (p: { id: string; pattern: RegExp; reason?: string; weight?: number; threat?: Threat }) => void };

  private packSpec: (string | PolicyPack)[];
  private policyPackVersion: string;
  private readonly guardStack: GuardStack;
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly clock: () => Date;
  private readonly stage2?: Stage2Hooks;
  private readonly onEvent?: (e: ScoutEvent) => void;
  private readonly issued = new Map<string, Remembered>();

  constructor(opts: ScoutOptions) {
    this.registry = IntentRegistry.load(opts.intentRegistry);
    this.capabilities = new CapabilityGraph({ defaults: opts.defaultTools });
    this.models = new ModelRouter(opts.modelProfiles, opts.routing);
    this.secret = opts.signingSecret ?? process.env.SCOUT_SECRET ?? process.env.CONTRACT_SECRET ?? randomBytes(32).toString("hex");
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = opts.clock ?? (() => new Date());
    this.stage2 = opts.stage2;
    this.onEvent = opts.onEvent;

    const spec = opts.policyPack ?? "default";
    this.packSpec = Array.isArray(spec) ? [...spec] : [spec];
    const pack = composePacks(this.packSpec);
    this.policyPackVersion = pack.versionTag;
    this.guardStack = new GuardStack(pack, (id) => this.capabilities.knows(id), this.clock);

    // Custom patterns extend the composed pack as one extra "custom" pack, versioned by count.
    const custom: InjectionPattern[] = [];
    this.policy = {
      addInjectionPattern: ({ id, pattern, weight = 0.9, threat = "tool_abuse" }) => {
        custom.push({ id, re: new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")), weight, threat, method: "pattern" });
        const extra: PolicyPack = { id: "custom", version: custom.length, injection: { patterns: [...custom] } };
        this.packSpec = [...this.packSpec.filter((p) => typeof p === "string" || p.id !== "custom"), extra];
        const next = composePacks(this.packSpec);
        this.policyPackVersion = next.versionTag;
        this.guardStack.setPack(next);
      },
    };

    // Stage 1 must scan the full registry inside 16 ms; fail loudly if it cannot.
    this.selfTest = opts.selfTest === false ? { ok: true, medianMs: 0, maxMs: 0, probes: 0, budgetMs: 16 } : selfTest(this.registry);
    if (!this.selfTest.ok) {
      const msg = `Scout self-test: Stage-1 scan median ${this.selfTest.medianMs} ms exceeds the ${this.selfTest.budgetMs} ms budget`;
      if (opts.selfTest === "warn") console.warn(msg);
      else throw new Error(msg);
    }
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** Sense only: scored top-k candidates. */
  async classify(input: { prompt: string; surface?: string; user?: UserRef; context?: SessionContext }): Promise<{ candidates: IntentCandidate[]; stage2: Decision["stage2"] }> {
    const user = input.user ?? { id: "anonymous" };
    const s2 = await runStage2(this.stage2, input.prompt, this.registry);
    const { candidates } = sense(input.prompt, { registry: this.registry, context: input.context, semantic: s2.scores, riskPenalty: this.penalty(user) });
    return { candidates, stage2: s2.status };
  }

  /** Sense + Interpret for composed prompts, with the merged tool plan. */
  async classifyMulti(input: { prompt: string; surface?: string; user?: UserRef; context?: SessionContext }) {
    const user = input.user ?? { id: "anonymous" };
    const u = await this.understand({ ...input, user });
    const picks = this.inOrder(u);
    const { steps } = this.capabilities.plan(
      picks.map((p) => ({ intent: p.intent, parameters: u.bindings.get(p.intent.id)?.parameters ?? {} })),
      { user, surface: input.surface ?? "chat" },
    );
    return {
      primary: u.primary.intent.id,
      intents: picks.map((p) => ({ intent: p.intent.id, score: p.confidence, span: p.span ?? input.prompt, parameters: u.bindings.get(p.intent.id)?.parameters ?? {} })),
      executionMode: u.mode,
      toolPlan: steps.map((s) => ({ tool: s.tool, capability: s.capability, fromIntent: s.fromIntent })),
    };
  }

  /** Guard only (no contract): injection, policy, scope, PII and rate-limit verdicts. */
  async guard(input: { prompt: string; user?: UserRef; surface?: string; snippets?: string[]; context?: SessionContext; intent?: string }): Promise<GuardResult> {
    const user = input.user ?? { id: "anonymous" };
    const surface = input.surface ?? "chat";
    const context = { ...input.context, snippets: [...(input.context?.snippets ?? []), ...(input.snippets ?? [])] };
    const u = await this.understand({ prompt: input.prompt, user, surface, context, intent: input.intent });
    const intents = u.clarification && u.clarification.trigger !== "high-risk" ? [] : this.guardIntents(u);
    return this.guardStack.evaluate({ prompt: input.prompt, user, surface, intents, context, modelInjection: await this.modelInjection(input.prompt), record: false });
  }

  /** Route only: the tool plan for a known intent. Throws ScoutError when a capability cannot resolve. */
  async plan(input: { intent: string; parameters?: Record<string, unknown>; user?: UserRef; surface?: string }): Promise<{ toolPlan: ToolStep[]; unresolved: UnresolvedCapability[] }> {
    const intent = this.registry.get(input.intent);
    if (!intent) throw new ScoutError("unknown_intent", `intent "${input.intent}" is not in the registry`);
    const { steps, unresolved } = this.capabilities.plan([{ intent, parameters: input.parameters ?? {} }], {
      user: input.user ?? { id: "anonymous" },
      surface: input.surface ?? "chat",
    });
    const failed = unresolved.filter((x) => x.severity === "error");
    if (failed.length) {
      throw new ScoutError("capability_unavailable", `no usable tool for ${failed.map((f) => `${f.capability} (${f.error})`).join(", ")}`, unresolved);
    }
    return { toolPlan: steps, unresolved };
  }

  /** The full pipeline. */
  async decide(input: DecideInput): Promise<Decision> {
    return this.run(input, {});
  }

  /** A downstream engine could not fulfil a step: decide again on the same trace, with lineage. */
  async replan(input: { parent: string; reason: string; state?: unknown }): Promise<Decision> {
    const prior = this.issued.get(input.parent);
    if (!prior) throw new ScoutError("unknown_contract", `no contract ${input.parent} issued by this Scout`);
    const unavailable = new Set(prior.unavailable);
    if (/unavailable|offline|down|fail|error|timeout|timed out|rate.?limit/i.test(input.reason)) {
      const reason = input.reason.toLowerCase();
      for (const id of this.capabilities.toolIds()) if (reason.includes(id.toLowerCase())) unavailable.add(id);
    }
    return this.run({ ...prior.input, traceId: prior.contract.traceId }, { parentId: prior.contract.contractId, unavailable, replanReason: input.reason });
  }

  /**
   * Record an approval. Contracts are immutable once signed, so this re-issues: new id,
   * parentId = the approved contract, same trace, same expiry (approval never extends TTL).
   */
  approve(contract: ScoutContract, approval: Omit<ApprovalRecord, "at"> & { at?: string }): ScoutContract {
    const check = this.verify(contract, { requireApprovals: false });
    if (!check.ok) throw new ScoutError("invalid_contract", `cannot approve contract ${contract.contractId}: ${check.reason}`);
    const now = this.clock();
    const record: ApprovalRecord = { ...approval, at: approval.at ?? now.toISOString() };
    const next = signScoutContract(
      {
        ...withoutSignature(contract),
        contractId: ulid(now.getTime()),
        parentId: contract.contractId,
        issuedAt: now.toISOString(),
        risk: { ...contract.risk, approvals: [...contract.risk.approvals, record] },
      },
      this.secret,
    );
    const prior = this.issued.get(contract.contractId);
    if (prior) this.remember(next, prior.input, prior.unavailable);
    this.emit({ type: "contract.issued", traceId: next.traceId, contractId: next.contractId, intent: next.intent.primary.id, risk: next.risk.level, profile: next.modelProfile.id });
    return next;
  }

  /** Boundary check with this instance's secret. */
  verify(contract: ScoutContract, opts: { now?: Date; requireApprovals?: boolean } = {}): VerifyResult {
    return verifyScoutContract(contract, { secret: this.secret, now: opts.now ?? this.clock(), requireApprovals: opts.requireApprovals });
  }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------

  private async run(input: DecideInput, lineage: { parentId?: string; unavailable?: Set<string>; replanReason?: string }): Promise<Decision> {
    const t0 = performance.now();
    const user = input.user ?? { id: "anonymous" };
    const surface = input.surface ?? "chat";
    const traceId = input.traceId ?? `tr_${ulid(this.clock().getTime()).toLowerCase()}`;
    const u = await this.understand({ ...input, user, surface });

    const confirming = u.clarification?.trigger === "high-risk";
    const asking = u.clarification !== null && !confirming;
    const modelInjection = await this.modelInjection(input.prompt);
    const risk = this.guardStack.evaluate({
      prompt: input.prompt,
      user,
      surface,
      intents: asking ? [] : this.guardIntents(u),
      context: input.context,
      modelInjection,
      record: true,
    });

    const decision: Decision = {
      traceId,
      // While asking from the Reject band there is no meaningful best guess to report.
      intent: asking && u.primary.confidence < BANDS.low ? null : this.bound(u, u.primary),
      secondary: u.secondary.map((s) => this.bound(u, s)),
      executionMode: u.mode,
      candidates: u.candidates,
      clarification: u.clarification,
      risk,
      toolPlan: [],
      unresolved: [],
      modelProfile: null,
      executionContract: null,
      stage2: u.stage2,
      latencyMs: 0,
    };

    const finish = () => {
      decision.latencyMs = Math.round((performance.now() - t0) * 100) / 100;
      this.emit({ type: "scout.decision", traceId, intent: decision.intent?.id ?? null, band: decision.intent?.band ?? null, latencyMs: decision.latencyMs, stage2: u.stage2 });
      return decision;
    };

    // Guard verdicts win over everything: a blocked request is not routed, planned or clarified.
    if (risk.level === "block") {
      decision.clarification = null;
      this.emit({ type: "scout.block", traceId, reason: risk.reason ?? "blocked", kinds: risk.flags.filter((f) => f.severity === "block").map((f) => f.kind) });
      return finish();
    }
    if (asking) {
      this.emit({ type: "scout.clarification", traceId, trigger: u.clarification!.trigger });
      return finish();
    }

    // Route: the plan follows clause order so dependent steps run after what they consume.
    const picks = this.inOrder(u);
    const { steps, unresolved } = this.capabilities.plan(
      picks.map((p) => ({ intent: p.intent, parameters: u.bindings.get(p.intent.id)?.parameters ?? {} })),
      { user, surface, unavailable: lineage.unavailable },
    );
    decision.toolPlan = steps;
    decision.unresolved = unresolved;
    const failed = unresolved.filter((x) => x.severity === "error");
    if (failed.length) {
      decision.error = { code: "capability_unavailable", message: `no usable tool for ${failed.map((f) => `${f.capability} (${f.error})`).join(", ")}` };
      this.emit({ type: "contract.refused", traceId, reason: decision.error.message });
      return finish();
    }

    // Recommend: model profile per step; sensitive input stays on cleared (local) profiles.
    const dataClass: DataClass = input.dataClass ?? (risk.redactions.length ? "confidential" : "internal");
    const intents = new Map(picks.map((p) => [p.intent.id, p.intent]));
    decision.modelProfile = this.models.assign(steps, intents, dataClass, input.budget) ?? NO_PROFILE;

    if (confirming) this.emit({ type: "scout.clarification", traceId, trigger: "high-risk" });
    const contract = this.issue(u, decision, input, { user, surface, traceId, parentId: lineage.parentId });
    decision.executionContract = contract;
    this.remember(contract, input, lineage.unavailable ?? new Set());
    this.emit({ type: "contract.issued", traceId, contractId: contract.contractId, intent: contract.intent.primary.id, risk: contract.risk.level, profile: contract.modelProfile.id });
    return finish();
  }

  /** Sense + Interpret. */
  private async understand(input: DecideInput & { user: UserRef }): Promise<Understanding> {
    const registry = this.registry;
    const riskPenalty = this.penalty(input.user);
    const general = registry.general();

    // Structured callers name the intent; Sense is skipped and confidence is 1.
    if (input.intent) {
      const intent = registry.get(input.intent) ?? (input.intent === general.id ? general : undefined);
      if (!intent) throw new ScoutError("unknown_intent", `intent "${input.intent}" is not in the registry`);
      const analysis = analyze(input.prompt, (w) => registry.index.common.has(w));
      const binding = bindParameters(intent, input.prompt, analysis.entities, input.parameters);
      const candidates: IntentCandidate[] = [
        { intent: intent.id, score: 1, band: "high", components: { lexical: 1, semantic: null, contextual: null, recency: null, riskPenalty: 0 } },
      ];
      const clarification = binding.missing.length
        ? clarify({ registry, text: input.prompt, candidates, entities: [], termCount: 1, multi: false, primary: { intent, confidence: 1, missing: binding.missing } })
        : null;
      return {
        analysis,
        candidates,
        stage2: "skipped",
        primary: { intent, confidence: 1, start: 0 },
        secondary: [],
        multi: false,
        mode: "single_step",
        bindings: new Map([[intent.id, binding]]),
        clarification,
      };
    }

    const s2 = await runStage2(this.stage2, input.prompt, registry);
    const { analysis, candidates } = sense(input.prompt, { registry, context: input.context, semantic: s2.scores, riskPenalty });
    const top = candidates[0]!;

    // Multi-intent: disjoint clauses, the primary in the High band, secondaries at Medium or above,
    // and each secondary must add capabilities the plan does not already have.
    const spanPicks = senseSpans(input.prompt, { registry, context: input.context, riskPenalty });
    const distinct = new Map<string, Picked>();
    for (const p of spanPicks) {
      const intent = registry.get(p.intent);
      if (!intent || intent.id === general.id) continue;
      const prev = distinct.get(p.intent);
      if (!prev || p.score > prev.confidence) distinct.set(p.intent, { intent, confidence: p.score, span: p.span, start: prev?.start ?? p.start });
    }
    let primary: Picked | undefined;
    const secondary: Picked[] = [];
    if (distinct.size >= 2) {
      const rank = (id: string) => {
        const i = candidates.findIndex((c) => c.intent === id);
        return i < 0 ? candidates.length : i;
      };
      const ordered = [...distinct.values()].sort((a, b) => rank(a.intent.id) - rank(b.intent.id) || b.confidence - a.confidence);
      const lead = ordered[0]!;
      if (lead.confidence >= BANDS.high) {
        const covered = new Set(lead.intent.capabilities);
        for (const s of [...distinct.values()].sort((a, b) => a.start - b.start)) {
          if (s === lead || s.confidence < BANDS.medium) continue;
          if (s.intent.capabilities.every((c) => covered.has(c))) continue;
          s.intent.capabilities.forEach((c) => covered.add(c));
          secondary.push(s);
        }
        if (secondary.length) primary = lead;
      }
    }
    const multi = primary !== undefined;
    if (!primary) {
      const intent = registry.get(top.intent) ?? general;
      primary = { intent, confidence: top.score, start: 0 };
    }

    const bindings = new Map<string, Binding>();
    for (const p of [primary, ...secondary]) {
      const text = p.span ?? input.prompt;
      const entities = p.span ? analyze(p.span, (w) => registry.index.common.has(w)).entities : analysis.entities;
      bindings.set(p.intent.id, bindParameters(p.intent, text, entities, p === primary ? input.parameters : undefined));
    }

    const clarification = clarify({
      registry,
      text: input.prompt,
      candidates,
      entities: analysis.entities,
      termCount: analysis.terms.length,
      multi,
      context: input.context,
      primary: { intent: primary.intent, confidence: primary.confidence, missing: bindings.get(primary.intent.id)!.missing },
      secondary: secondary.map((s) => ({ intent: s.intent, confidence: s.confidence })),
    });

    // Reject band with nothing to ask: fall back to the safe GENERAL intent; never guess.
    if (!clarification && !multi && primary.confidence < BANDS.low && primary.intent.id !== general.id) {
      const from = primary.intent.id;
      primary = { intent: general, confidence: primary.confidence, start: 0, fallbackFrom: from };
      bindings.set(general.id, bindParameters(general, input.prompt, analysis.entities));
    }

    return {
      analysis,
      candidates,
      stage2: s2.status,
      primary,
      secondary,
      multi,
      mode: multi ? executionModeOf([primary, ...secondary].sort((a, b) => a.start - b.start).map((p) => p.span ?? "")) : "single_step",
      bindings,
      clarification,
    };
  }

  private issue(u: Understanding, d: Decision, input: DecideInput, ids: { user: UserRef; surface: string; traceId: string; parentId?: string }): ScoutContract {
    const now = this.clock();
    const binding = u.bindings.get(u.primary.intent.id)!;
    const level = d.risk.level as RiskClass;
    return signScoutContract(
      {
        contractId: ulid(now.getTime()),
        ...(ids.parentId ? { parentId: ids.parentId } : {}),
        traceId: ids.traceId,
        intent: {
          primary: { id: u.primary.intent.id, version: u.primary.intent.version },
          parameters: binding.parameters,
          references: binding.references,
          confidence: u.primary.confidence,
          alternates: u.candidates.filter((c) => c.intent !== u.primary.intent.id).slice(0, 3).map((c) => ({ intent: c.intent, score: c.score })),
          secondary: u.secondary.map((s) => ({
            id: s.intent.id,
            span: s.span,
            confidence: s.confidence,
            parameters: u.bindings.get(s.intent.id)?.parameters ?? {},
          })),
          executionMode: u.mode,
        },
        risk: {
          level,
          flags: d.risk.flags,
          redactions: d.risk.redactions,
          approvalsRequired: d.risk.approvalsRequired,
          approvals: [],
        },
        toolPlan: d.toolPlan,
        modelProfile: d.modelProfile ?? NO_PROFILE,
        scope: {
          user: ids.user,
          surface: ids.surface,
          capabilities: d.toolPlan.map((s) => s.capability),
          ...(input.budget ? { budget: input.budget } : {}),
        },
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
        registryVersion: this.registry.version,
        registryDigest: this.registry.digest,
        policyPackVersion: this.policyPackVersion,
        signedBy: "scout",
      },
      this.secret,
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Intents of the plan in clause order (single-intent plans are just the primary). */
  private inOrder(u: Understanding): Picked[] {
    return [u.primary, ...u.secondary].sort((a, b) => a.start - b.start);
  }

  private guardIntents(u: Understanding): GuardIntent[] {
    return [u.primary, ...u.secondary].map((p) => {
      const b = u.bindings.get(p.intent.id);
      return { intent: p.intent, parameters: b?.parameters ?? {}, problems: b?.problems ?? [] };
    });
  }

  private bound(u: Understanding, p: Picked): BoundIntent {
    const b = u.bindings.get(p.intent.id);
    return {
      id: p.intent.id,
      version: p.intent.version,
      confidence: p.confidence,
      band: bandOf(p.confidence),
      ...(p.span ? { span: p.span } : {}),
      parameters: b?.parameters ?? {},
      references: b?.references ?? {},
      ...(p.fallbackFrom ? { fallbackFrom: p.fallbackFrom } : {}),
    };
  }

  private penalty(user: UserRef): (intentId: string) => number {
    return (id) => {
      const intent = this.registry.get(id);
      return intent && this.guardStack.deniedCapabilities(intent, user).length ? 0.25 : 0;
    };
  }

  private async modelInjection(text: string): Promise<{ score: number; kind?: string } | undefined> {
    const hook = this.stage2?.injection;
    if (!hook) return undefined;
    try {
      const r = await withTimeout(hook(text), this.stage2?.timeoutMs ?? 2000);
      return Number.isFinite(r?.score) ? { score: Math.max(0, Math.min(1, r.score)), kind: r.kind } : undefined;
    } catch {
      return undefined;
    }
  }

  private remember(contract: ScoutContract, input: DecideInput, unavailable: Set<string>): void {
    this.issued.set(contract.contractId, { contract, input, unavailable });
    if (this.issued.size > MAX_REMEMBERED) this.issued.delete(this.issued.keys().next().value!);
  }

  private emit(e: ScoutEvent): void {
    try {
      this.onEvent?.(e);
    } catch {
      // telemetry must never break a decision
    }
  }
}
