// Lotline's trace graph on top of the World Model.
//
// Every TraceLink becomes one bitemporal edge, valid from the moment the
// source records say it happened. Direction convention (from -> to):
//
//   harvested-as   harvest lot   -> lot it was packed as        (downstream)
//   received-as    shipped lot   -> lot/LPN it was received as  (downstream)
//   shipped-to     lot or LPN    -> location                    (downstream)
//   derived-from   output lot    -> input lot                   (UPSTREAM: walked in reverse)
//
// Supply-chain edges record events, not exclusive state: a lot split across
// partial shipments sits at several locations at once, and a commingled
// repack has several inputs. So every link kind uses cardinality "many" and
// nothing is superseded.

import type { Evidence, LinkKind, LinkStatus, TraceLink } from "@lotline/core";
import { compare } from "./store.ts";
import type { Cardinality, IngestReport, Relationship } from "./types.ts";
import type { WorldModel } from "./world.ts";

export const LINK_KINDS: readonly LinkKind[] = ["harvested-as", "received-as", "shipped-to", "derived-from"];

export const LINK_CARDINALITY: Readonly<Record<LinkKind, Cardinality>> = {
  "harvested-as": "many",
  "received-as": "many",
  "shipped-to": "many",
  "derived-from": "many",
};

/** Kinds whose stored direction points upstream, so tracing forward walks them backwards. */
const UPSTREAM_KINDS: ReadonlySet<string> = new Set<LinkKind>(["derived-from"]);

export interface LinkRelation {
  from: string;
  type: LinkKind;
  to: string;
  validFrom: string;
  cardinality: Cardinality;
  attrs: { status: LinkStatus; confidence: number; quantity?: number; evidence: string[] };
  source: { kind: "zetaris"; at: string; ref: string; linkId: string };
}

/** Stable key of a source row: `source:table#rowKey`. */
export const evidenceKey = (e: Evidence): string => `${e.source}:${e.table}#${e.rowKey}`;

/**
 * Maps a TraceLink to a relate() input. The edge content is what the records
 * prove (status, confidence, quantity, which rows); query ids and the link id
 * go into provenance, so re-proving the same link with fresh queries on a
 * re-run is corroboration and leaves the graph unchanged.
 */
export function linkToRelation(link: TraceLink): LinkRelation {
  const unique = (values: string[]) => [...new Set(values)].sort(compare);
  return {
    from: link.from,
    type: link.kind,
    to: link.to,
    validFrom: link.at,
    cardinality: LINK_CARDINALITY[link.kind],
    attrs: {
      status: link.status,
      confidence: link.confidence,
      ...(link.quantity !== undefined ? { quantity: link.quantity } : {}),
      evidence: unique(link.evidence.map(evidenceKey)),
    },
    source: { kind: "zetaris", at: link.at, ref: unique(link.evidence.map((e) => e.queryId)).join(","), linkId: link.id },
  };
}

/** Writes trace links into the world. Re-ingesting the same links reports `changed: false`. */
export function ingestLinks(world: WorldModel, links: TraceLink[], options: { runId?: string } = {}): Promise<IngestReport> {
  return world.ingestRelations(links.map(linkToRelation), options);
}

export interface ReachOptions {
  /** point in time; only edges valid then are followed. Omitted means "now". */
  at?: string | Date;
  /** link kinds to follow (default: all four) */
  via?: readonly LinkKind[];
  /**
   * Only follow links with one of these statuses. Default: everything except
   * "rejected", so unproven and contested links still propagate (a possibly
   * affected location must be held, not silently dropped).
   */
  statuses?: readonly LinkStatus[];
  /** do not expand past these nodes (they are still reported as reached) */
  stopAt?: (id: string) => boolean;
}

export interface PathStep {
  /** node the step leaves, in tracing order */
  from: string;
  /** node the step reaches */
  to: string;
  via: string;
  /** "reverse" when a derived-from edge was walked from input lot to output lot */
  direction: "forward" | "reverse";
  /** the stored edge, with its attrs (status, evidence) and provenance */
  edge: Relationship;
}

/** Every entity downstream of a lot (output lots, LPNs, locations), sorted, excluding the lot itself. */
export function reachableFrom(world: WorldModel, lotId: string, options: ReachOptions = {}): string[] {
  const start = world.view("graph").resolve(lotId);
  const reached = new Set<string>([start]);
  walk(world, start, options, (step) => {
    if (reached.has(step.to)) return false;
    reached.add(step.to);
    return true;
  });
  reached.delete(start);
  return [...reached].sort(compare);
}

/**
 * The shortest chain of edges that carries product from `from` to `to`, each
 * with its provenance (for the evidence appendix). [] when from === to, null
 * when `to` is not downstream of `from`.
 */
export function explainPath(world: WorldModel, from: string, to: string, options: ReachOptions = {}): PathStep[] | null {
  const graph = world.view("graph");
  const start = graph.resolve(from);
  const goal = graph.resolve(to);
  if (start === goal) return [];
  const cameBy = new Map<string, PathStep>();
  walk(world, start, options, (step) => {
    if (cameBy.has(goal) || step.to === start || cameBy.has(step.to)) return false;
    cameBy.set(step.to, step);
    return step.to !== goal;
  });
  if (!cameBy.has(goal)) return null;
  const path: PathStep[] = [];
  for (let node = goal; node !== start; node = cameBy.get(node)!.from) path.unshift(cameBy.get(node)!);
  return path;
}

/**
 * Breadth-first walk downstream from `start`. `visit` decides whether the
 * step's target is new and should be expanded. Steps are taken in a fixed
 * order, so results are deterministic.
 */
function walk(world: WorldModel, start: string, options: ReachOptions, visit: (step: PathStep) => boolean): void {
  const graph = world.view("graph");
  const via = options.via ?? LINK_KINDS;
  const allowed = (edge: Relationship) => {
    const status = edge.attrs.status as LinkStatus | undefined;
    return options.statuses ? status !== undefined && options.statuses.includes(status) : status !== "rejected";
  };
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (node !== start && options.stopAt?.(node)) continue;
    const steps: PathStep[] = [];
    for (const edge of graph.edges(node, { via, at: options.at })) {
      if (!allowed(edge)) continue;
      const upstream = UPSTREAM_KINDS.has(edge.type);
      if (!upstream && edge.from === node) steps.push({ from: node, to: edge.to, via: edge.type, direction: "forward", edge });
      if (upstream && edge.to === node) steps.push({ from: node, to: edge.from, via: edge.type, direction: "reverse", edge });
    }
    steps.sort((a, b) => compare(a.to, b.to) || compare(a.edge.validFrom, b.edge.validFrom) || compare(a.edge.id, b.edge.id));
    for (const step of steps) if (visit(step)) queue.push(step.to);
  }
}
