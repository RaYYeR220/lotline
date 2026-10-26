import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs the vendored official Meterless runner, unmodified, against this package.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const runner = fileURLToPath(new URL("../../vendor/meterless/markovian/runner.ts", import.meta.url));
const impl = fileURLToPath(new URL("../src/index.ts", import.meta.url)).replaceAll("\\", "/");

describe("official Markovian conformance runner", () => {
  it("passes every check", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", runner], {
      cwd: root,
      env: { ...process.env, MARKOVIAN_IMPL: impl },
      encoding: "utf8",
    });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).toContain("8/8 checks passed");
    expect(output).not.toContain("FAIL");
    expect(run.status).toBe(0);
  });
});
