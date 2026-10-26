// Entity resolution: is a new name the same thing as one we already know?
//
//   similarity >= 0.85          -> auto-merge (written as an alias, never an overwrite)
//   0.82 <= similarity < 0.85   -> operator review queue
//   similarity < 0.82           -> new entity
//
// Both boundaries are inclusive on the upper band: 0.85 exactly merges, 0.82
// exactly queues. Similarity is 1 - levenshtein / longer length, computed on
// normalized names so accents and spacing never count as edits.

import { normalizeName } from "./ids.ts";

export type MergeDecision = "auto-merge" | "review" | "new";

export const MERGE_BANDS = { autoMergeAt: 0.85, reviewFloor: 0.82 } as const;

export function decide(similarity: number, bands: { autoMergeAt?: number; reviewFloor?: number } = {}): MergeDecision {
  const autoMergeAt = bands.autoMergeAt ?? MERGE_BANDS.autoMergeAt;
  const reviewFloor = bands.reviewFloor ?? MERGE_BANDS.reviewFloor;
  if (similarity >= autoMergeAt) return "auto-merge";
  if (similarity >= reviewFloor) return "review";
  return "new";
}

/** Edit distance over code points, two-row dynamic programming. */
export function levenshtein(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      const substitution = prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1);
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, substitution));
    }
    prev = row;
  }
  return prev[y.length];
}

export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  const longest = Math.max(Array.from(x).length, Array.from(y).length);
  if (longest === 0) return 1;
  return 1 - levenshtein(x, y) / longest;
}
