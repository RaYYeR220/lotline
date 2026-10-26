import type { z } from "zod";

/** Pull the first JSON object out of a model reply (bare, fenced or wrapped in prose). */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in reply");
}

export function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    const result = schema.safeParse(extractJson(raw));
    if (result.success) return { ok: true, value: result.data };
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
