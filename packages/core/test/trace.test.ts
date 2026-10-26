import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TraceLog, loadConfig } from "../src/index.ts";

const REQUIRED = [
  "timestamp", "run_id", "agent_name", "action", "input_summary", "output_summary",
  "target_agent", "model", "confidence", "retry_count", "status",
];

describe("TraceLog", () => {
  it("writes one JSON line per event with every required key", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "trace-"));
    const log = new TraceLog("run-1", { dir, stdout: false });
    log.emit({ agent_name: "IntakeAgent", action: "parse_notice", input_summary: "notice", output_summary: "scope", status: "success" });
    log.emit({ agent_name: "TracerAgent", action: "zetaris.query", input_summary: "q", output_summary: "3 rows", target_agent: "EvidenceCritic", model: null, confidence: 0.5, status: "success" });
    const lines = readFileSync(path.join(dir, "run-1.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const e = JSON.parse(line);
      for (const k of REQUIRED) expect(e).toHaveProperty(k);
      expect(e.run_id).toBe("run-1");
    }
    expect(JSON.parse(lines[0]).retry_count).toBe(0);
    expect(JSON.parse(lines[0]).target_agent).toBeNull();
  });

  it("delivers events to subscribers in order and can unsubscribe", () => {
    const log = new TraceLog("run-2", { stdout: false, dir: mkdtempSync(path.join(tmpdir(), "trace-")) });
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.action));
    log.emit({ agent_name: "A", action: "one", input_summary: "", output_summary: "", status: "success" });
    log.emit({ agent_name: "A", action: "two", input_summary: "", output_summary: "", status: "success" });
    off();
    log.emit({ agent_name: "A", action: "three", input_summary: "", output_summary: "", status: "success" });
    expect(seen).toEqual(["one", "two"]);
    expect(log.events().map((e) => e.action)).toEqual(["one", "two", "three"]);
  });
});

describe("loadConfig", () => {
  it("reads sample mode and lanes from env with defaults", () => {
    const cfg = loadConfig({ SAMPLE_MODE: "true", LANE_REASON: "x/y" });
    expect(cfg.sampleMode).toBe(true);
    expect(cfg.lanes.reason).toBe("x/y");
    expect(cfg.nightshift.baseUrl).toBe("http://127.0.0.1:8088/v1");
    expect(cfg.lanes.fast).toBeTruthy();
  });
});
