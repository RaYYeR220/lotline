// Validation and normalization for the write path (normalize -> resolve ->
// validate -> append -> project). Everything here is pure: a batch is fully
// validated before its first event is appended, so a bad record rejects the
// batch instead of leaving half of it in the log.

import { canonicalJson, normalizeName, sha256Hex, toIso } from "./ids.ts";
import type { IngestObservation, Provenance, StoredProvenance } from "./types.ts";

/** No provenance, no write. Normalizes `at` to ISO-8601 UTC. */
export function checkProvenance(source: Provenance | undefined): StoredProvenance {
  const missing =
    !source || typeof source !== "object" ||
    typeof source.kind !== "string" || source.kind === "" ||
    source.at === undefined || source.at === null || source.at === "";
  if (missing) throw new Error("World Model: every write needs provenance (source.kind and source.at); no provenance, no write");
  return { ...source, at: toIso(source.at, "source.at") };
}

export interface PreparedObservation {
  externalId: string;
  type: string;
  title: string;
  text?: string;
  at: string;
  source: StoredProvenance;
  mentions: { type: string; name: string }[];
  /** content hash: the dedupe key that makes re-ingest a no-op */
  checksum: string;
}

export function prepareObservation(obs: IngestObservation, position: number): PreparedObservation {
  if (!obs || typeof obs.externalId !== "string" || obs.externalId === "") {
    throw new Error(`World Model: observation #${position} has no externalId`);
  }
  if (typeof obs.title !== "string") throw new Error(`World Model: observation ${obs.externalId} has no title`);
  const at = toIso(obs.at, `observation ${obs.externalId} at`);
  const source = checkProvenance(obs.source && { ...obs.source, at: obs.source.at ?? at });
  const mentions = (obs.entities ?? []).map((m) => {
    if (!m || typeof m.type !== "string" || typeof m.name !== "string" || normalizeName(m.name) === "") {
      throw new Error(`World Model: observation ${obs.externalId} mentions an entity without a type and name`);
    }
    return { type: m.type, name: m.name };
  });
  const type = obs.type ?? "item";
  const checksum = sha256Hex(canonicalJson({
    externalId: obs.externalId, type, title: obs.title, text: obs.text, at,
    mentions: mentions.map((m) => `${m.type}:${normalizeName(m.name)}`).sort(),
  }));
  return { externalId: obs.externalId, type, title: obs.title, text: obs.text, at, source, mentions, checksum };
}

/** Deterministic run id for a batch: the same batch always gets the same id. */
export function batchRunId(parts: string[]): string {
  return `run_${sha256Hex(parts.join("\n")).slice(0, 12)}`;
}

/** Drops undefined members so they never show up as content. */
export function compact(attrs: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs ?? {}).filter(([, v]) => v !== undefined));
}
