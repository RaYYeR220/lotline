import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs the vendored official Meterless runner, unmodified, against this package.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const runner = fileURLToPath(new URL("../../vendor/meterless/hmem/runner.ts", import.meta.url));
const impl = fileURLToPath(new URL("../src/index.ts", import.meta.url)).replaceAll("\\", "/");

describe("official H-MEM conformance runner", () => {
  it("passes every check", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", runner], {
      cwd: root,
      env: { ...process.env, HMEM_IMPL: impl },
      encoding: "utf8",
    });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).toContain("13/13 checks passed");
    expect(output).not.toContain("FAIL");
    expect(run.status).toBe(0);
  });
});
