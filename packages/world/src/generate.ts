import { computeKey } from "./key.ts";
import { renderNotices } from "./notice.ts";
import { renderWorld } from "./render.ts";
import { Rng } from "./rng.ts";
import { Scenario, ScenarioRetry } from "./scenario.ts";
import {
  buildOutlets, distribute, numberConsignments, packBatches, receiveAtDc, shipDirect, shipFromPacker,
  simulateHarvests, sortLines, type Flow,
} from "./simulate.ts";
import type { World, WorldSpec } from "./types.ts";

export const DEFAULT_SPEC: WorldSpec = { seed: 7, days: 60, startDate: "2026-08-20" };

/**
 * Build a seeded partner world: the physical flow of product from fields to
 * stores, the notices that implicate part of it, the planted anomalies, every
 * partner system's records of it, and the answer key. Pure and deterministic:
 * the same spec always yields the same world.
 */
export function generateWorld(spec: WorldSpec): World {
  if (!Number.isInteger(spec.seed)) throw new Error("seed must be an integer");
  if (spec.days < 45) throw new Error("days must be at least 45 so every notice has room for a full trace");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spec.startDate)) throw new Error("startDate must be YYYY-MM-DD");

  // Same base world every attempt; only the scenario stream (which lots the notices pick) changes.
  for (let attempt = 0; attempt < MAX_SCENARIO_ATTEMPTS; attempt++) {
    try {
      return build(spec, attempt);
    } catch (err) {
      if (!(err instanceof ScenarioRetry)) throw err;
    }
  }
  throw new Error(`seed ${spec.seed}: no scenario fits this world after ${MAX_SCENARIO_ATTEMPTS} attempts`);
}

const MAX_SCENARIO_ATTEMPTS = 12;

function build(spec: WorldSpec, attempt: number): World {
  const rng = new Rng(spec.seed);
  const flow: Flow = { spec: { ...spec }, fields: [], harvests: [], batches: [], consignments: [], receipts: [], lines: [], outlets: [] };
  flow.outlets = buildOutlets(rng.fork("outlets"));

  // Fields → packer.
  simulateHarvests(flow, rng.fork("harvest"));
  packBatches(flow, rng.fork("pack"));
  const scenario = new Scenario(flow, rng.fork(attempt === 0 ? "scenario" : `scenario#${attempt}`));
  scenario.shapeBatches();

  // Loads into Northgate.
  shipFromPacker(flow, rng.fork("ship"));
  shipDirect(flow, rng.fork("direct"));
  scenario.shapeConsignments();
  numberConsignments(flow, rng.fork("numbers"));

  // Northgate DC → stores and food service.
  receiveAtDc(flow, rng.fork("receive"));
  distribute(flow, rng.fork("distribute"));
  sortLines(flow);
  scenario.shapeDownstream();

  // Write it all down, then grade it.
  const { tables, bolScans } = renderWorld(flow, rng.fork("render"));
  const anomalies = scenario.anomalies();
  const notices = renderNotices(flow, scenario.plans, rng.fork("notices"));
  const key = computeKey(flow, scenario.plans, notices, anomalies, spec.seed);
  return { spec: { ...spec }, tables, bolScans, notices, key };
}
