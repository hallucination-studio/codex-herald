import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  IMessageDestination,
  LifecycleEvent,
  Notification,
} from "../src/domain/types.js";
import {
  MAX_PROCESS_OUTPUT_BYTES,
  runSafeProcess,
  SAFE_PROCESS_CWD,
} from "../src/system/process.js";
import {
  inspectIMessage,
  MAX_IMSG_VERSION_CHARS,
  sendIMessage,
} from "../src/transports/imessage.js";

const event: LifecycleEvent = {
  id: "evt_test",
  type: "turn.finished",
  source: "codex",
  sourceEvent: "Stop",
  occurredAt: "2026-07-11T00:00:00.000Z",
  summary: "Finished",
};

const notification: Notification = {
  title: "Codex turn finished",
  body: "Implemented the requested change.",
  severity: "info",
  truncated: false,
};

function destination(
  overrides: Partial<IMessageDestination> = {},
): IMessageDestination {
  return {
    id: "phone",
    transport: "imessage",
    driver: "imsg",
    recipient: "+8613800000000",
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe("sendIMessage", () => {
  it("passes recipient and body as exact argv data without a shell", async () => {
    await withFakeImsg(async ({ directory, executable }) => {
      const capturePath = join(directory, "capture.json");
      const injectedPath = join(directory, "must-not-exist");
      const recipient = `+86138; touch ${injectedPath}`;
      const body = `$(touch ${injectedPath}) \`touch ${injectedPath}\``;

      await installNodeExecutable(
        executable,
        `
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  canary: process.env.CODEX_HERALD_SECRET_CANARY ?? null,
}));
process.stdout.write(JSON.stringify({ status: "sent" }));
`,
      );

      const previousCanary = process.env.CODEX_HERALD_SECRET_CANARY;
      process.env.CODEX_HERALD_SECRET_CANARY = "must-not-reach-imsg";
      try {
        const outcome = await sendIMessage(
          destination({ recipient }),
          event,
          { ...notification, body },
          "darwin",
        );

        assert.deepEqual(outcome, {
          status: "accepted",
          code: "imsg_accepted",
        });
      } finally {
        restoreEnvironment("CODEX_HERALD_SECRET_CANARY", previousCanary);
      }

      const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
        argv: string[];
        cwd: string;
        canary: string | null;
      };
      assert.deepEqual(capture.argv, [
        "send",
        "--to",
        recipient,
        "--text",
        body,
        "--service",
        "imessage",
        "--json",
      ]);
      assert.equal(capture.cwd, SAFE_PROCESS_CWD);
      assert.equal(capture.canary, null);
      assert.equal(await pathExists(injectedPath), false);
    });
  });

  it("maps an absent imsg on PATH to driver_not_found", async () => {
    await withFakeImsg(async () => {
      const outcome = await sendIMessage(destination(), event, notification, "darwin");

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_not_found",
      });
    });
  });

  it("rejects an imsg executable found through a world-writable PATH directory", async () => {
    await withFakeImsg(async ({ directory, executable }) => {
      const marker = join(directory, "executed");
      await installNodeExecutable(
        executable,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");\n` +
          'process.stdout.write(JSON.stringify({ status: "sent" }));',
      );
      await chmod(directory, 0o777);

      const outcome = await sendIMessage(destination(), event, notification, "darwin");

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_not_found",
      });
      assert.equal(await pathExists(marker), false);
    });
  });

  it("rejects a world-writable imsg executable in a trusted PATH directory", async () => {
    await withFakeImsg(async ({ directory, executable }) => {
      const marker = join(directory, "executed");
      await installNodeExecutable(
        executable,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");\n` +
          'process.stdout.write(JSON.stringify({ status: "sent" }));',
      );
      await chmod(executable, 0o777);

      const outcome = await sendIMessage(destination(), event, notification, "darwin");

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_not_found",
      });
      assert.equal(await pathExists(marker), false);
    });
  });

  it("accepts a safe executable from a current-user Homebrew-style directory", async () => {
    await withFakeImsg(async ({ directory, executable }) => {
      await installNodeExecutable(
        executable,
        'process.stdout.write(JSON.stringify({ status: "sent" }));',
      );
      await chmod(directory, 0o775);

      const outcome = await sendIMessage(destination(), event, notification, "darwin");

      assert.deepEqual(outcome, {
        status: "accepted",
        code: "imsg_accepted",
      });
    });
  });

  it("never executes imsg outside macOS", async () => {
    await withFakeImsg(async ({ directory, executable }) => {
      const marker = join(directory, "executed");
      await installNodeExecutable(
        executable,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");\n` +
          'process.stdout.write(JSON.stringify({ status: "sent" }));',
      );
      const outcome = await sendIMessage(destination(), event, notification, "linux");

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_not_found",
      });
      assert.equal(await pathExists(marker), false);
    });
  });

  it("maps exit code 1 to driver_failed", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(
        executable,
        'process.stderr.write("send failed"); process.exit(1);',
      );

      const outcome = await sendIMessage(destination(), event, notification, "darwin");

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_failed",
      });
    });
  });

  it("maps signal termination to driver_terminated", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(executable, 'process.kill(process.pid, "SIGTERM");');

      const outcome = await sendIMessage(destination(), event, notification, "darwin");

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_terminated",
      });
    });
  });

  it("maps timeout to driver_timeout and does not retry", async () => {
    await withFakeImsg(async ({ directory, executable }) => {
      const invocationPath = join(directory, "invocations.txt");
      await installNodeExecutable(
        executable,
        `
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(invocationPath)}, "1");
setInterval(() => undefined, 1_000);
`,
      );

      const outcome = await sendIMessage(
        destination({ timeoutMs: 750 }),
        event,
        notification,
        "darwin",
      );

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_timeout",
      });
      assert.equal(await readFile(invocationPath, "utf8"), "1");
    });
  });

  it("rejects invalid JSON from a successful process", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(executable, 'process.stdout.write("sent");');

      const outcome = await sendIMessage(destination(), event, notification, "darwin");

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_invalid_response",
      });
    });
  });

  it("rejects JSON without the exact sent status", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(
        executable,
        'process.stdout.write(JSON.stringify({ status: "queued" }));',
      );

      const outcome = await sendIMessage(destination(), event, notification, "darwin");

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_invalid_response",
      });
    });
  });

  it("caps stdout and stderr independently at 16 KiB", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(
        executable,
        `
process.stdout.write("x".repeat(${MAX_PROCESS_OUTPUT_BYTES + 1024}));
process.stderr.write("y".repeat(${MAX_PROCESS_OUTPUT_BYTES + 2048}));
`,
      );

      const result = await runSafeProcess(executable, [], 1_000);

      assert.equal(result.kind, "exited");
      assert.equal(Buffer.byteLength(result.stdout), MAX_PROCESS_OUTPUT_BYTES);
      assert.equal(Buffer.byteLength(result.stderr), MAX_PROCESS_OUTPUT_BYTES);
      assert.equal(result.stdoutTruncated, true);
      assert.equal(result.stderrTruncated, true);
    });
  });

  it("classifies a spawn ENOENT as not_found", async () => {
    const result = await runSafeProcess(
      join(tmpdir(), `missing-imsg-${process.pid}-${Date.now()}`),
      [],
      100,
    );

    assert.equal(result.kind, "not_found");
  });
});

describe("inspectIMessage", () => {
  it("reports a bounded version only after both capability probes pass", async () => {
    await withFakeImsg(async ({ directory, executable }) => {
      const invocationPath = join(directory, "inspection-invocations.ndjson");
      await installNodeExecutable(
        executable,
        `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(invocationPath)}, JSON.stringify(args) + "\\n");
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("imsg 0.12.3\\nignored second line\\n");
} else if (args.length === 2 && args[0] === "send" && args[1] === "--help") {
  process.stdout.write("Usage: imsg send --to VALUE --text VALUE --service VALUE --json\\n");
} else {
  process.exit(2);
}
`,
      );

      const inspection = await inspectIMessage("darwin");

      assert.deepEqual(inspection, {
        ok: true,
        code: "ready",
        version: "imsg 0.12.3",
      });
      const invocations = (await readFile(invocationPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(invocations, [["--version"], ["send", "--help"]]);
    });
  });

  it("limits the returned version to the first 128 Unicode code points", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(
        executable,
        `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("😀".repeat(${MAX_IMSG_VERSION_CHARS + 5}) + "\\nnot returned");
} else {
  process.stdout.write("--to --text --service --json");
}
`,
      );

      const inspection = await inspectIMessage("darwin");

      assert.equal(inspection.ok, true);
      if (inspection.ok) {
        assert.equal(Array.from(inspection.version).length, MAX_IMSG_VERSION_CHARS);
        assert.doesNotMatch(inspection.version, /not returned/u);
      }
    });
  });

  it("maps an absent executable to driver_not_found", async () => {
    await withFakeImsg(async () => {
      assert.deepEqual(await inspectIMessage("darwin"), {
        ok: false,
        code: "driver_not_found",
      });
    });
  });

  it("maps a failed version or help process to driver_failed", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(executable, "process.exit(1);");

      assert.deepEqual(await inspectIMessage("darwin"), {
        ok: false,
        code: "driver_failed",
      });
    });

    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(
        executable,
        `
if (process.argv[2] === "--version") {
  process.stdout.write("imsg 0.12.3");
} else {
  process.exit(1);
}
`,
      );

      assert.deepEqual(await inspectIMessage("darwin"), {
        ok: false,
        code: "driver_failed",
      });
    });
  });

  it("rejects missing capabilities as driver_invalid_response", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(
        executable,
        `
if (process.argv[2] === "--version") {
  process.stdout.write("imsg 0.12.3");
} else {
  process.stdout.write("Usage: imsg send --to VALUE --text VALUE --json");
}
`,
      );

      assert.deepEqual(await inspectIMessage("darwin"), {
        ok: false,
        code: "driver_invalid_response",
      });
    });
  });
});

interface FakeImsgContext {
  directory: string;
  executable: string;
}

async function withFakeImsg(
  action: (context: FakeImsgContext) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codex-herald-imsg-"));
  const executable = join(directory, "imsg");
  const previousPath = process.env.PATH;
  process.env.PATH = directory;

  try {
    await action({ directory, executable });
  } finally {
    restoreEnvironment("PATH", previousPath);
    await rm(directory, { recursive: true, force: true });
  }
}

async function installNodeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${source}\n`, "utf8");
  await chmod(path, 0o755);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
