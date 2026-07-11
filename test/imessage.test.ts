import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, it } from "node:test";
import type {
  IMessageDestination,
  LifecycleEvent,
  Notification,
} from "../src/domain/types.js";
import {
  checkIMessageReadiness,
  type IMessageReadiness,
  inspectIMessage,
  sendIMessage,
} from "../src/transports/imessage.js";

const event: LifecycleEvent = {
  id: "evt_test",
  type: "turn.finished",
  source: "codex",
  sourceEvent: "Stop",
  project: "herald",
  occurredAt: "2026-07-11T00:00:00.000Z",
  summary: "Finished",
};

const notification: Notification = {
  title: "Codex Herald",
  body:
    "Source: Codex\nProject: herald\nEvent: Turn finished\n\n" +
    "Summary:\nImplemented the requested change.",
  severity: "info",
  truncated: false,
};

async function readyIMessage(): Promise<IMessageReadiness> {
  return { ok: true, code: "ready" };
}

function destination(
  overrides: Partial<IMessageDestination> = {},
): IMessageDestination {
  return {
    id: "phone",
    transport: "imessage",
    driver: "imsg",
    recipient: "+8613800000000",
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("sendIMessage", () => {
  it("does not invoke imsg when the Messages account is not ready", async () => {
    await withFakeImsg(async ({ directory, executable }) => {
      const marker = join(directory, "send-invoked");
      await installNodeExecutable(
        executable,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");\n` +
          'process.stdout.write(JSON.stringify({ status: "sent" }));',
      );

      const outcome = await sendIMessage(
        destination(),
        event,
        notification,
        "darwin",
        async () => ({ ok: false, code: "imessage_not_ready" }),
      );

      assert.deepEqual(outcome, {
        status: "failed",
        code: "imessage_not_ready",
      });
      assert.equal(await pathExists(marker), false);
    });
  });

  it("does not invoke imsg when the Messages account check fails", async () => {
    await withFakeImsg(async ({ directory, executable }) => {
      const marker = join(directory, "send-invoked");
      await installNodeExecutable(
        executable,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");`,
      );

      const outcome = await sendIMessage(
        destination(),
        event,
        notification,
        "darwin",
        async () => ({ ok: false, code: "imessage_check_failed" }),
      );

      assert.deepEqual(outcome, {
        status: "failed",
        code: "imessage_check_failed",
      });
      assert.equal(await pathExists(marker), false);
    });
  });

  it("passes recipient and the complete Herald message as exact argv data", async () => {
    await withFakeImsg(async ({ directory, executable }) => {
      const capturePath = join(directory, "capture.json");
      const injectedPath = join(directory, "must-not-exist");
      const recipient = `+86138; touch ${injectedPath}`;
      const title = "Codex Herald";
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
          { ...notification, title, body },
          "darwin",
          readyIMessage,
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
        `${title}\n${body}`,
        "--service",
        "imessage",
        "--json",
      ]);
      assert.equal(capture.cwd, parse(process.execPath).root);
      assert.equal(capture.canary, null);
      assert.equal(await pathExists(injectedPath), false);
    });
  });

  it("maps an absent imsg on PATH to driver_not_found", async () => {
    await withFakeImsg(async () => {
      const outcome = await sendIMessage(
        destination(),
        event,
        notification,
        "darwin",
        readyIMessage,
      );

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_not_found",
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

      const outcome = await sendIMessage(
        destination(),
        event,
        notification,
        "darwin",
        readyIMessage,
      );

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_failed",
      });
    });
  });

  it("maps signal termination to driver_terminated", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(executable, 'process.kill(process.pid, "SIGTERM");');

      const outcome = await sendIMessage(
        destination(),
        event,
        notification,
        "darwin",
        readyIMessage,
      );

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
        async (_platform, timeoutMs) => {
          assert.equal(timeoutMs, 750);
          return { ok: true, code: "ready" };
        },
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

      const outcome = await sendIMessage(
        destination(),
        event,
        notification,
        "darwin",
        readyIMessage,
      );

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

      const outcome = await sendIMessage(
        destination(),
        event,
        notification,
        "darwin",
        readyIMessage,
      );

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_invalid_response",
      });
    });
  });

  it("fails safely when imsg exceeds the process output limit", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(
        executable,
        `
process.stdout.write("x".repeat(${17 * 1024}));
process.stderr.write("y".repeat(${18 * 1024}));
`,
      );

      const outcome = await sendIMessage(
        destination(),
        event,
        notification,
        "darwin",
        readyIMessage,
      );

      assert.deepEqual(outcome, {
        status: "failed",
        code: "driver_failed",
      });
    });
  });
});

describe("inspectIMessage", () => {
  it("reports a disconnected Messages account as not ready", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(executable, 'process.stdout.write("0.12.3\\n");');

      assert.deepEqual(
        await inspectIMessage("darwin", async () => ({
          ok: false,
          code: "imessage_not_ready",
        })),
        { ok: false, code: "imessage_not_ready" },
      );
    });
  });

  it("reports the version using only the basic version probe", async () => {
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
} else {
  process.exit(2);
}
`,
      );

      const inspection = await inspectIMessage("darwin", readyIMessage);

      assert.deepEqual(inspection, {
        ok: true,
        code: "ready",
        version: "imsg 0.12.3",
      });
      const invocations = (await readFile(invocationPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(invocations, [["--version"]]);
    });
  });

  it("maps an absent executable to driver_not_found", async () => {
    await withFakeImsg(async () => {
      assert.deepEqual(await inspectIMessage("darwin", readyIMessage), {
        ok: false,
        code: "driver_not_found",
      });
    });
  });

  it("maps a failed version process to driver_failed", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(executable, "process.exit(1);");

      assert.deepEqual(await inspectIMessage("darwin", readyIMessage), {
        ok: false,
        code: "driver_failed",
      });
    });
  });

  it("rejects an empty version response", async () => {
    await withFakeImsg(async ({ executable }) => {
      await installNodeExecutable(executable, "process.stdout.write('');");

      assert.deepEqual(await inspectIMessage("darwin", readyIMessage), {
        ok: false,
        code: "driver_invalid_response",
      });
    });
  });
});

describe("checkIMessageReadiness", () => {
  it("uses a fixed AppleScript probe without recipient or message content", async () => {
    const canaryRecipient = "private-recipient@example.com";
    const canaryBody = "private notification body";

    const result = await checkIMessageReadiness(
      "darwin",
      5_000,
      async (executable, args, timeoutMs) => {
        assert.equal(executable, "/usr/bin/osascript");
        assert.equal(timeoutMs, 5_000);
        assert.deepEqual(args.slice(0, 1), ["-e"]);
        const script = args.join("\n");
        assert.match(script, /services whose service type is iMessage/u);
        assert.match(script, /item 1 of imessageServices/u);
        assert.doesNotMatch(script, new RegExp(canaryRecipient, "u"));
        assert.doesNotMatch(script, new RegExp(canaryBody, "u"));
        return { kind: "exited", stdout: "ready\n" };
      },
    );

    assert.deepEqual(result, { ok: true, code: "ready" });
  });

  it("fails closed when the AppleScript probe cannot establish readiness", async () => {
    assert.deepEqual(
      await checkIMessageReadiness("darwin", 5_000, async () => ({
        kind: "exited",
        stdout: "check_failed\n",
      })),
      { ok: false, code: "imessage_check_failed" },
    );
  });

  it("reports a disabled or disconnected account as not ready", async () => {
    assert.deepEqual(
      await checkIMessageReadiness("darwin", 5_000, async () => ({
        kind: "exited",
        stdout: "not_ready\n",
      })),
      { ok: false, code: "imessage_not_ready" },
    );
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
