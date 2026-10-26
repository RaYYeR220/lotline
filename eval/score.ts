import type { RunResult } from "@lotline/core";

export interface NoticeKey {
  affectedLocations: string[];
  unaffectedLocations: string[];
  ambiguousLinks: { from: string; to: string; reason: string }[];
}

export interface NoticeScore {
  noticeId: string;
  affected: number;
  caught: number;
  missed: string[];
  falseClear: string[];
  pulledUnaffected: string[];
  provableClears: number;
  clearsMade: number;
  holds: number;
  pulls: number;
}

/** Scores one run against the hidden answer key. A miss or a CLEAR on an affected location is the critical failure. */
export function scoreRun(noticeId: string, result: Pick<RunResult, "actions">, key: NoticeKey): NoticeScore {
  const byLoc = new Map(result.actions.map((a) => [a.locationId, a.kind]));
  const affected = new Set(key.affectedLocations);
  const missed = key.affectedLocations.filter((l) => !byLoc.has(l));
  const falseClear = key.affectedLocations.filter((l) => byLoc.get(l) === "CLEAR");
  const pulledUnaffected = [...byLoc].filter(([l, k]) => k === "PULL" && !affected.has(l)).map(([l]) => l);
  return {
    noticeId,
    affected: affected.size,
    caught: key.affectedLocations.filter((l) => byLoc.has(l) && byLoc.get(l) !== "CLEAR").length,
    missed,
    falseClear,
    pulledUnaffected,
    provableClears: key.unaffectedLocations.filter((l) => byLoc.get(l) === "CLEAR").length,
    clearsMade: [...byLoc.values()].filter((k) => k === "CLEAR").length,
    holds: [...byLoc.values()].filter((k) => k === "HOLD").length,
    pulls: [...byLoc.values()].filter((k) => k === "PULL").length,
  };
}
