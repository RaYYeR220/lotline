import { describe, expect, it } from "vitest";
import { runScoutHarness } from "../../../../scripts/conformance-scout.ts";

describe("Meterless Scout eval harness (vendored, upstream thresholds)", () => {
  it("meets every hard floor, ceiling and slice floor in thresholds.yaml", () => {
    const run = runScoutHarness("all");
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("Loaded 32 examples");
    expect(run.report).toContain("PASS");
    expect(run.output).not.toMatch(/Skipped /);
  });
});
