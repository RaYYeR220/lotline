// Stable, content-derived identifiers. Same input, same id, on every machine
// and every re-run: this is what makes ingest idempotent and merges safe.

import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * lowercase -> NFKD -> strip combining marks -> drop zero-width characters ->
 * collapse whitespace -> trim.
 *
 * Accents and odd spaces never split one name into two ids, but nothing is
 * abbreviated or stemmed: "Acme Corp" and "Acme Corporation" stay different.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Name-keyed entity id: `ent_` + first 16 hex of sha256(`type:normalizedName`). */
export function entityIdFromName(type: string, name: string): string {
  return `ent_${sha256Hex(`${type}:${normalizeName(name)}`).slice(0, 16)}`;
}

/** Externally keyed entity id: the literal `type:system:externalId`. */
export function externalEntityId(type: string, system: string, id: string): string {
  return `${type}:${system}:${id}`;
}

/** Edge id: hash of its identity. Asserting the same edge twice targets the same record. */
export function relationId(from: string, type: string, to: string, context: string | undefined, validFrom: string): string {
  return `rel_${sha256Hex([from, type, to, context ?? "", validFrom].join("\u001f")).slice(0, 16)}`;
}

/**
 * Deterministic JSON: object keys sorted, undefined members dropped. Plain
 * JSON.stringify follows insertion order, which would make two equal states
 * compare unequal.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Normalizes a timestamp to full ISO-8601 UTC. A bare date means the start of that day. */
export function toIso(value: string | Date, what = "timestamp"): string {
  const ms = value instanceof Date ? value.getTime() : Date.parse(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(ms)) throw new Error(`World Model: ${what} is not a readable timestamp: ${String(value)}`);
  return new Date(ms).toISOString();
}

/** A point-in-time query. A bare date means "as of the end of that day". */
export function toInstant(value: string | Date): string {
  if (typeof value === "string" && DATE_ONLY.test(value)) return `${value}T23:59:59.999Z`;
  return toIso(value, "point-in-time");
}
