import type { Evidence } from "@lotline/core";
import type { QueryResult, Row } from "@lotline/adapters";
import { canonicalLot } from "./lotcodes.ts";

export const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
export const inList = (values: Iterable<string>) => `(${[...new Set(values)].map(q).join(", ") || "''"})`;

/** Every spelling a partner system is known to use for a lot (packer codes drift between systems). */
export function spellings(code: string): string[] {
  const c = canonicalLot(code);
  const out = new Set([code.trim(), code.trim().toUpperCase(), c]);
  const m = c.match(/^PK(\d{6})(\d{3})$/);
  if (m) {
    out.add(`PK-${m[1]}-${m[2]}`);
    out.add(`PK-${m[1]}-${Number(m[2])}`);
  }
  return [...out];
}

export const dayDiff = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000);
export const addDays = (iso: string, n: number) => new Date(Date.parse(iso.slice(0, 10)) + n * 86_400_000).toISOString().slice(0, 10);

/** Evidence pointer for one row returned by the data layer. */
export function evidence(res: QueryResult, table: string, pk: string, row: Row): Evidence {
  const dot = table.lastIndexOf(".");
  const source = dot < 0 ? table : table.slice(0, dot);
  const name = dot < 0 ? table : table.slice(dot + 1);
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) if (v != null) fields[k] = v;
  return { source, table: name, rowKey: String(row[pk] ?? ""), queryId: res.queryId, sql: res.sql, fields };
}
