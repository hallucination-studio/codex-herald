import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";

describe("codex-herald CLI", () => {
  it("prints the package version", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["--version"], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(output, ["0.1.0"]);
    assert.deepEqual(errors, []);
  });

  it("prints concise help", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["--help"], {
      stdout: (line) => output.push(line),
      stderr: () => undefined,
    });

    assert.equal(exitCode, 0);
    assert.match(output.join("\n"), /codex-herald setup/);
    assert.match(output.join("\n"), /codex-herald ingest/);
  });
});
