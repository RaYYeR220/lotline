// Folds the trace-event stream (and, once it arrives, the RunResult) into what the board draws.
import type {
  ActionKind,
  Approval,
  Evidence,
  LinkKind,
  LinkStatus,
  PanelVote,
  RecallScope,
  RunResult,
  TraceEvent,
} from "../lib/types.tsx";

export interface GLink {
  id: string;
  kind: LinkKind;
  from: string;
  to: string;
  at: string;
  quantity?: number;
  status: LinkStatus;
  /** Status inferred from the critic finishing without challenging this link; the final result confirms it. */
  inferred: boolean;
  notes: string[];
  evidence: Evidence[];
  summary: string;
  seq: number;
  retries: number;
  votes?: PanelVote[];
  confidence?: number | null;
}

export interface Ghost {
  lot: string;
  recalled: string;
  location: string;
  note: string;
}

export interface ActionView {
  locationId: string;
  locationName?: string;
  kind: ActionKind;
  lots: string[];
  rationale?: string;
  contractId: string;
  approval: Approval;
  risk?: string;
  seq: number;
}

export interface Flagged {
  row: string;
  signals: string[];
  summary: string;
  text?: string;
}

export interface Refusal {
  intent: string;
  target: string;
  reason: string;
  summary: string;
  provenEvidence?: number;
  flagged?: Flagged;
  seq: number;
}

export interface BoardState {
  scope?: RecallScope;
  implicated: string[];
  noLots?: string;
  links: GLink[];
  ghosts: Ghost[];
  actions: ActionView[];
  refusals: Refusal[];
  flagged: Flagged[];
  counters: { queries: number; modelCalls: number; retries: number; panels: number };
  systems: Record<string, number>;
  criticDone: boolean;
  planReady: boolean;
  done: boolean;
  names: Record<string, string>;
}

const strip = (s: string) => s.replace(/^(lot|lpn|loc):/, "");
const AFTER_CRITIC = new Set(["ActionPlanner", "LotMatcher", "ScoutGate", "Reporter"]);

type Detail = Record<string, unknown>;

export function deriveBoard(events: TraceEvent[], result: RunResult | null, approvals: Record<string, Approval>): BoardState {
  let scope: RecallScope | undefined;
  let implicated: string[] = [];
  let noLots: string | undefined;
  const links = new Map<string, GLink>();
  const ghosts = new Map<string, Ghost>();
  const actions = new Map<string, ActionView>();
  const refusals: Refusal[] = [];
  const flagged: Flagged[] = [];
  const systems: Record<string, number> = {};
  const decided: Record<string, Approval> = {};
  let queries = 0, modelCalls = 0, retries = 0, panels = 0;
  let criticDone = false, planReady = false, done = false;

  events.forEach((e, i) => {
    const d = (e.detail ?? {}) as Detail;
    switch (e.action) {
      case "scope.ready":
        scope = d.scope as RecallScope;
        break;
      case "lots.resolved":
        implicated = ((d.lots as string[]) ?? []).map(strip);
        if (!implicated.length) noLots = e.output_summary;
        break;
      case "zetaris.query": {
        queries++;
        const seen = new Set<string>();
        for (const m of String(d.sql ?? "").matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\.[a-z_]+/gi)) seen.add(m[1].toLowerCase());
        for (const s of seen) systems[s] = (systems[s] ?? 0) + 1;
        break;
      }
      case "nightshift.chat":
      case "rules.fallback":
        modelCalls++;
        break;
      case "link.proposed": {
        const l = d.link as { id: string; kind: LinkKind; from: string; to: string; at: string; quantity?: number } | undefined;
        if (l) links.set(l.id, { ...l, status: "proposed", inferred: false, notes: [], evidence: [], summary: e.output_summary, seq: i, retries: 0 });
        break;
      }
      case "link.challenged": {
        const l = links.get(String(d.link_id));
        if (l) {
          l.status = "contested";
          l.notes.push(...e.output_summary.split("; ").filter(Boolean));
        }
        break;
      }
      case "retry.requested": {
        retries++;
        const l = links.get(e.input_summary);
        if (l) l.retries++;
        break;
      }
      case "panel.tally": {
        panels++;
        const l = links.get(e.input_summary.replace(/^contested\s+/, ""));
        if (l) l.votes = (d.votes as PanelVote[]) ?? [];
        break;
      }
      case "link.ruled": {
        const l = links.get(String(d.link_id));
        if (l) {
          l.status = (d.link_status as LinkStatus) ?? l.status;
          if (Array.isArray(d.notes)) l.notes = d.notes as string[];
          l.confidence = e.confidence;
        }
        break;
      }
      case "injection.flagged":
        flagged.push({ row: String(d.row ?? e.input_summary), signals: (d.signals as string[]) ?? [], summary: e.output_summary });
        break;
      case "near_miss.checked": {
        const m = e.input_summary.match(/^(\S+)\s+vs recalled\s+(\S+)/);
        const location = String(d.location ?? "");
        if (m && location) ghosts.set(`${m[1]}|${location}`, { lot: m[1], recalled: m[2], location, note: e.output_summary });
        break;
      }
      case "contract.issued": {
        const c = d.contract as { id: string; intent: string; target: string; args?: { lots?: string[] }; risk?: string; requiresApproval?: boolean } | undefined;
        if (c) {
          const prev = actions.get(c.target);
          actions.set(c.target, {
            locationId: c.target,
            kind: c.intent.toUpperCase() as ActionKind,
            lots: (c.args?.lots ?? []).map(strip),
            contractId: c.id,
            approval: c.requiresApproval ? "pending" : "not-required",
            risk: c.risk,
            seq: prev?.seq ?? i,
          });
        }
        break;
      }
      case "contract.refused":
        refusals.push({
          intent: String(d.intent ?? ""),
          target: String(d.target ?? ""),
          reason: String(d.reason ?? "refused"),
          summary: e.output_summary,
          provenEvidence: typeof d.proven_evidence === "number" ? d.proven_evidence : undefined,
          seq: i,
        });
        break;
      case "contract.approve":
      case "contract.reject":
        if (d.contract_id) decided[String(d.contract_id)] = e.action === "contract.approve" ? "approved" : "rejected";
        break;
      case "plan.ready":
        planReady = true;
        break;
      case "run.done":
      case "run.failed":
        done = true;
        break;
    }
    if (AFTER_CRITIC.has(e.agent_name) || e.action === "injection.flagged") criticDone = true;
  });

  // The critic rules on every link before planning starts; a link it never challenged met the proof bar.
  if (criticDone) for (const l of links.values()) if (l.status === "proposed") Object.assign(l, { status: "proven", inferred: true });

  const names: Record<string, string> = {};
  let actionList = [...actions.values()];

  if (result) {
    for (const rl of result.links) {
      const l = links.get(rl.id);
      if (l) Object.assign(l, { status: rl.status, inferred: false, notes: rl.notes, evidence: rl.evidence, confidence: rl.confidence, quantity: rl.quantity });
      else links.set(rl.id, { ...rl, inferred: false, summary: `${rl.evidence.length} record(s)`, seq: events.length, retries: 0 });
    }
    const seqOf = new Map(actionList.map((a) => [a.locationId, a.seq]));
    actionList = result.actions.map((a, i) => ({
      locationId: a.locationId,
      locationName: a.locationName,
      kind: a.kind,
      lots: a.lots,
      rationale: a.rationale,
      contractId: a.contractId,
      approval: a.approval,
      risk: actions.get(a.locationId)?.risk,
      seq: seqOf.get(a.locationId) ?? events.length + i,
    }));
    for (const a of result.actions) names[a.locationId] = a.locationName;
    queries = result.stats.queries;
    modelCalls = result.stats.modelCalls;
    retries = result.stats.retries;
    panels = Math.max(panels, result.stats.races);
    scope = scope ?? result.scope;
  }

  // Every CLEAR shows the lots it rests on, including ones the near-miss check had no reason to compare.
  for (const a of actionList) {
    if (a.kind !== "CLEAR") continue;
    for (const lot of a.lots) {
      if (!ghosts.has(`${lot}|${a.locationId}`)) ghosts.set(`${lot}|${a.locationId}`, { lot, recalled: "", location: a.locationId, note: a.rationale ?? "every lot received in the window traced to inputs outside the recall" });
    }
  }

  for (const a of actionList) {
    const override = approvals[a.contractId] ?? decided[a.contractId];
    if (override && a.approval === "pending") a.approval = override;
  }

  // Quote the flagged partner note from the evidence it arrived in.
  const allEvidence = [...links.values()].flatMap((l) => l.evidence);
  for (const f of flagged) {
    const ev = allEvidence.find((e) => `${e.source}.${e.table}:${e.rowKey}` === f.row);
    if (ev?.fields.notes) f.text = ev.fields.notes;
  }
  for (const r of refusals) {
    if (r.reason === "injection") r.flagged = flagged.find((f) => (f.text ?? "").includes(r.target)) ?? flagged[0];
  }

  return {
    scope,
    implicated,
    noLots,
    links: [...links.values()].sort((a, b) => a.seq - b.seq),
    ghosts: [...ghosts.values()],
    actions: actionList.sort((a, b) => a.seq - b.seq),
    refusals,
    flagged,
    counters: { queries, modelCalls, retries, panels },
    systems,
    criticDone,
    planReady,
    done,
    names,
  };
}

/** Parses a model id into what the model chip shows. */
export function parseModel(model: string | null): { label: string; vendor?: string; replay: boolean; rules: boolean } | null {
  if (!model) return null;
  if (model === "rules/fallback") return { label: "rules fallback", replay: false, rules: true };
  const replay = model.startsWith("cache/");
  const id = replay ? model.slice(6) : model;
  const [vendor, ...rest] = id.split("/");
  return rest.length ? { label: rest.join("/"), vendor, replay, rules: false } : { label: id, replay, rules: false };
}
