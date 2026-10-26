// Read surface. Views are projections of the event log; they hand out copies
// so a consumer can never edit canonical state by accident.

import { toInstant } from "./ids.ts";
import { compare, type Projection } from "./store.ts";
import type { Entity, Relationship } from "./types.ts";

export interface EdgeQuery {
  /** edge type, or several */
  via?: string | readonly string[];
  /** point in time; omitted means "now" (open edges only). A bare date means the end of that day. */
  at?: string | Date;
  /** default "both" */
  direction?: "out" | "in" | "both";
  inContext?: string;
  /** with no `at`, also return edges that have been closed */
  includeClosed?: boolean;
}

/** Is the edge valid at the instant (validFrom <= at < validTo)? With no instant: is it still open? */
export function isValidAt(edge: Relationship, at?: string | Date): boolean {
  if (at === undefined) return edge.validTo === undefined;
  const instant = toInstant(at);
  return edge.validFrom <= instant && (edge.validTo === undefined || instant < edge.validTo);
}

export class GraphView {
  private readonly state: Projection;

  constructor(state: Projection) {
    this.state = state;
  }

  /** The surviving id for an id that may have been merged away. */
  resolve(id: string): string {
    return this.state.resolve(id);
  }

  entity(id: string): Entity | undefined {
    const entity = this.state.entities.get(this.state.resolve(id));
    return entity && structuredClone(entity);
  }

  entities(filter: { type?: string } = {}): Entity[] {
    return [...this.state.entities.values()]
      .filter((e) => !filter.type || e.type === filter.type)
      .sort((a, b) => compare(a.id, b.id))
      .map((e) => structuredClone(e));
  }

  /** Edges touching a node, filtered by type, direction, context and validity; sorted by (from, to, validFrom, id). */
  edges(id: string, query: EdgeQuery = {}): Relationship[] {
    const node = this.state.resolve(id);
    const direction = query.direction ?? "both";
    const via = query.via === undefined ? undefined : new Set(typeof query.via === "string" ? [query.via] : query.via);
    const at = query.at === undefined ? undefined : toInstant(query.at);
    const candidates = [
      ...(direction !== "in" ? this.state.edgesOf(node, "out") : []),
      ...(direction !== "out" ? this.state.edgesOf(node, "in").filter((r) => r.from !== node || direction === "in") : []),
    ];
    return candidates
      .filter((r) => !via || via.has(r.type))
      .filter((r) => query.inContext === undefined || r.context === query.inContext)
      .filter((r) => (at === undefined && query.includeClosed) || isValidAt(r, at))
      .sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.validFrom, b.validFrom) || compare(a.id, b.id))
      .map((r) => structuredClone(r));
  }

  /** Entities on the other end of matching edges, each once, sorted by id. Undirected unless `direction` says otherwise. */
  neighborsOf(id: string, query: EdgeQuery = {}): Entity[] {
    const node = this.state.resolve(id);
    const ids = new Set<string>();
    for (const edge of this.edges(node, query)) ids.add(edge.from === node ? edge.to : edge.from);
    return [...ids]
      .sort(compare)
      .map((nid) => this.state.entities.get(nid))
      .filter((e): e is Entity => e !== undefined)
      .map((e) => structuredClone(e));
  }
}
