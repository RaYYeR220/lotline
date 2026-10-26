import type { PanelRes, PanelVote } from "./types.ts";

/** Majority vote over panel answers; two thirds or better is a decision, anything less is undecided. */
export function tally(votes: PanelVote[]): PanelRes {
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v.answer, (counts.get(v.answer) ?? 0) + 1);
  let winner: string | undefined;
  let best = 0;
  for (const [answer, n] of counts) {
    if (n > best) {
      best = n;
      winner = answer;
    }
  }
  const agreement = votes.length ? best / votes.length : 0;
  if (agreement >= 2 / 3 - 1e-9 && best >= 2) return { outcome: "accepted", winner, agreement, votes };
  return { outcome: "undecided", agreement, votes };
}
