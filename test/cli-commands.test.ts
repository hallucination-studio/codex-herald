import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type CliIo, type CliRuntime, runCli } from "../src/cli.js";
import { parseConfigText } from "../src/config/index.js";
import type { DeliveryResult } from "../src/domain/types.js";

describe("CLI commands", () => {
  it("setup creates the selected user config", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-cli-"));
    const path = join(root, "config", "config.toml");
    const output = captureIo();

    const exitCode = await runCli(
      ["setup", "--config", path],
      output.io,
      runtime({
        homeDir: root,
        sendIMessage: async () => {
          throw new Error("plain setup must not send a check notification");
        },
      }),
    );

    assert.equal(exitCode, 0);
    assert.match(output.stdout.join("\n"), /created/u);
    assert.match(output.stdout.join("\n"), new RegExp(escapeRegExp(path), "u"));
    assert.equal(output.stderr.length, 0);
  });

  it("setup configures an explicit iMessage recipient and sends a check", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-cli-"));
    const configPath = join(root, "config", "config.toml");
    const legacyStoragePath = join(root, "receipts.ndjson");
    const recipient = "private-imessage@example.com";
    const output = captureIo();
    let sends = 0;

    const exitCode = await runCli(
      ["setup", "--config", configPath, "--imessage-recipient", recipient],
      output.io,
      runtime({
        env: { CODEX_HERALD_RECEIPTS: legacyStoragePath },
        homeDir: root,
        sendIMessage: async (destination, _event, notification) => {
          sends += 1;
          assert.equal(destination.recipient, recipient);
          assert.deepEqual(notification, {
            title: "Codex Herald",
            body:
              "Source: Codex Herald\nProject: Setup\nEvent: Delivery check\n\n" +
              "Summary:\nYour iMessage destination is configured and ready.",
            severity: "info",
            truncated: false,
          });
          return { status: "accepted", code: "imsg_accepted" };
        },
      }),
    );

    assert.equal(exitCode, 0);
    assert.equal(sends, 1);
    assert.equal(output.stderr.length, 0);
    assert.doesNotMatch(output.stdout.join("\n"), new RegExp(recipient, "u"));
    assert.match(output.stdout.join("\n"), /phone: accepted \(imsg_accepted\)/u);
    const config = parseConfigText(await readFile(configPath, "utf8"));
    assert.equal(config.destinations.phone?.transport, "imessage");
    if (config.destinations.phone?.transport === "imessage") {
      assert.equal(config.destinations.phone.recipient, recipient);
    }
    assert.deepEqual(config.routes, [
      {
        events: ["turn.finished"],
        destinations: ["phone"],
        template: "compact",
      },
    ]);
    await assert.rejects(readFile(legacyStoragePath, "utf8"), { code: "ENOENT" });
  });

  it("setup keeps the configured destination when the automatic check fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-cli-"));
    const configPath = join(root, "config", "config.toml");
    const legacyStoragePath = join(root, "receipts.ndjson");
    const recipient = "failed-check@example.com";
    const output = captureIo();
    let sends = 0;

    const exitCode = await runCli(
      ["setup", "--config", configPath, "--imessage-recipient", recipient],
      output.io,
      runtime({
        env: { CODEX_HERALD_RECEIPTS: legacyStoragePath },
        homeDir: root,
        sendIMessage: async () => {
          sends += 1;
          return {
            status: "failed",
            code: "imessage_not_ready",
          };
        },
      }),
    );

    assert.equal(exitCode, 1);
    assert.equal(sends, 1);
    assert.doesNotMatch(output.stdout.join("\n"), new RegExp(recipient, "u"));
    assert.match(output.stdout.join("\n"), /Messages > Settings > iMessage/u);
    assert.equal(output.stderr.length, 0);
    const config = parseConfigText(await readFile(configPath, "utf8"));
    assert.equal(config.destinations.phone?.transport, "imessage");
    await assert.rejects(readFile(legacyStoragePath, "utf8"), { code: "ENOENT" });
  });

  it("setup rejects an empty iMessage recipient before creating a config", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-cli-"));
    const configPath = join(root, "config", "config.toml");
    const output = captureIo();

    const exitCode = await runCli(
      ["setup", "--config", configPath, "--imessage-recipient", "   "],
      output.io,
      runtime({ homeDir: root }),
    );

    assert.equal(exitCode, 2);
    assert.deepEqual(output.stdout, []);
    assert.equal(output.stderr.length, 1);
    await assert.rejects(readFile(configPath, "utf8"), { code: "ENOENT" });
  });

  it("ingest isolates destination failure and returns a Codex warning", async () => {
    const fixture = await configuredFixture(twoDestinationConfig());
    const output = captureIo();

    const exitCode = await runCli(
      ["ingest", "--source", "codex-stop", "--config", fixture.configPath],
      output.io,
      runtime({
        env: fixture.env,
        homeDir: fixture.root,
        stdin: chunks(JSON.stringify(validStopInput)),
        sendWebhook: async () => ({
          status: "failed",
          code: "webhook_network_error",
        }),
        sendIMessage: async () => ({
          status: "accepted",
          code: "imsg_accepted",
        }),
      }),
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(output.stdout, [
      JSON.stringify({
        systemMessage:
          "Codex Herald delivery failed: ops (webhook_network_error). " +
          "No retry was attempted; run codex-herald doctor.",
      }),
    ]);
    assert.deepEqual(output.stderr, []);
    await assert.rejects(readFile(fixture.legacyStoragePath, "utf8"), {
      code: "ENOENT",
    });
  });

  it("ingest ignores a missing config without writing state", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-cli-"));
    const legacyStoragePath = join(root, "receipts.ndjson");
    const output = captureIo();

    const exitCode = await runCli(
      ["ingest", "--source", "codex-stop", "--config", join(root, "missing.toml")],
      output.io,
      runtime({
        env: { CODEX_HERALD_RECEIPTS: legacyStoragePath },
        homeDir: root,
        stdin: chunks(JSON.stringify(validStopInput)),
      }),
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(output.stdout, []);
    assert.deepEqual(output.stderr, []);
    await assert.rejects(readFile(legacyStoragePath, "utf8"), { code: "ENOENT" });
  });

  it("ingest stays silent when every destination accepts the event", async () => {
    const fixture = await configuredFixture(singleWebhookConfig());
    const output = captureIo();

    const exitCode = await runCli(
      ["ingest", "--source", "codex-stop", "--config", fixture.configPath],
      output.io,
      runtime({
        env: fixture.env,
        homeDir: fixture.root,
        stdin: chunks(JSON.stringify(validStopInput)),
        sendWebhook: async () => ({
          status: "accepted",
          code: "webhook_accepted",
        }),
      }),
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(output.stdout, []);
    assert.deepEqual(output.stderr, []);
  });

  it("ingest reports iMessage readiness failure without writing state", async () => {
    const fixture = await configuredFixture(singleIMessageConfig());
    const output = captureIo();

    const exitCode = await runCli(
      ["ingest", "--source", "codex-stop", "--config", fixture.configPath],
      output.io,
      runtime({
        env: fixture.env,
        homeDir: fixture.root,
        stdin: chunks(JSON.stringify(validStopInput)),
        sendIMessage: async () => ({
          status: "failed",
          code: "imessage_not_ready",
        }),
      }),
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(output.stdout, [
      JSON.stringify({
        systemMessage:
          "Codex Herald delivery failed: phone (imessage_not_ready). " +
          "No retry was attempted; run codex-herald doctor.",
      }),
    ]);
    assert.deepEqual(output.stderr, []);
    await assert.rejects(readFile(fixture.legacyStoragePath, "utf8"), {
      code: "ENOENT",
    });
  });

  it("ingest reports malformed input without echoing it", async () => {
    const output = captureIo();
    const secret = "sk-never-echo-this-value";

    const exitCode = await runCli(
      ["ingest", "--source", "codex-stop"],
      output.io,
      runtime({ stdin: chunks(`{"secret":"${secret}"`) }),
    );

    assert.equal(exitCode, 1);
    assert.deepEqual(output.stdout, []);
    assert.match(output.stderr.join("\n"), /HOOK_INPUT_INVALID/u);
    assert.doesNotMatch(output.stderr.join("\n"), new RegExp(secret, "u"));
  });

  it("ingest maps every usage error to exit 1 without writing stdout", async () => {
    for (const args of [["ingest"], ["ingest", "--unknown"], ["ingest", "--help"]]) {
      const output = captureIo();

      const exitCode = await runCli(args, output.io, runtime());

      assert.equal(exitCode, 1, args.join(" "));
      assert.deepEqual(output.stdout, [], args.join(" "));
      assert.equal(output.stderr.length, 1, args.join(" "));
    }
  });

  it("ingest redacts unsafe config paths and terminal control characters", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-cli-redaction-"));
    const canary = "private-path-canary";
    const configPath = join(root, `${canary}-\u001b[31m\nconfig.toml`);
    const output = captureIo();
    await writeFile(configPath, singleWebhookConfig(), { mode: 0o644 });

    try {
      const exitCode = await runCli(
        ["ingest", "--source", "codex-stop", "--config", configPath],
        output.io,
        runtime({ stdin: chunks(JSON.stringify(validStopInput)) }),
      );

      assert.equal(exitCode, 1);
      assert.deepEqual(output.stdout, []);
      assert.deepEqual(output.stderr, ["CONFIG_UNSAFE: Codex Herald ingest failed"]);
      assert.doesNotMatch(output.stderr[0] ?? "", new RegExp(canary, "u"));
      for (const codePoint of [0x1b, 0x0d, 0x0a]) {
        assert.equal(
          (output.stderr[0] ?? "").includes(String.fromCodePoint(codePoint)),
          false,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("test emits an honest in-memory result as JSON", async () => {
    const fixture = await configuredFixture(singleWebhookConfig());
    const output = captureIo();

    const exitCode = await runCli(
      ["test", "ops", "--config", fixture.configPath, "--json"],
      output.io,
      runtime({
        env: fixture.env,
        homeDir: fixture.root,
        sendWebhook: async () => ({
          status: "accepted",
          code: "webhook_accepted",
        }),
      }),
    );

    assert.equal(exitCode, 0);
    assert.equal(output.stderr.length, 0);
    const result = JSON.parse(output.stdout.join("\n")) as DeliveryResult;
    assert.equal(result.status, "accepted");
    assert.equal(result.code, "webhook_accepted");
    assert.equal("delivered" in result, false);
    assert.equal("recordedAt" in result, false);
    assert.equal("transport" in result, false);
  });

  it("doctor reports readiness without printing resolved secrets", async () => {
    const secret = "https://hooks.example.com/super-secret-path";
    const fixture = await configuredFixture(singleWebhookConfig());
    const output = captureIo();

    const exitCode = await runCli(
      ["doctor", "--config", fixture.configPath, "--json"],
      output.io,
      runtime({
        env: { ...fixture.env, OPS_WEBHOOK_URL: secret },
        homeDir: fixture.root,
        inspectWebhook: async () => ({ ok: true, code: "ready" }),
      }),
    );

    assert.equal(exitCode, 0);
    assert.equal(output.stderr.length, 0);
    const rendered = output.stdout.join("\n");
    assert.doesNotMatch(rendered, /super-secret-path/u);
    const report = JSON.parse(rendered) as {
      ok: boolean;
      destinations: Array<{ id: string; status: string }>;
      codex: { hookTrust: string };
    };
    assert.equal(report.ok, true);
    assert.equal("receipts" in report, false);
    assert.deepEqual(report.destinations, [
      { id: "ops", transport: "webhook", status: "ready", code: "ready" },
    ]);
    assert.equal(report.codex.hookTrust, "manual_check");
  });

  it("doctor warns about every literal webhook URL without revealing it", async () => {
    const fixture = await configuredFixture(literalQueryWebhookConfig());
    const output = captureIo();

    const exitCode = await runCli(
      ["doctor", "--config", fixture.configPath, "--json"],
      output.io,
      runtime({
        env: fixture.env,
        homeDir: fixture.root,
        inspectWebhook: async () => ({ ok: true, code: "ready" }),
      }),
    );

    assert.equal(exitCode, 0);
    const rendered = output.stdout.join("\n");
    assert.doesNotMatch(rendered, /canary-query-secret/u);
    const report = JSON.parse(rendered) as { warnings: string[] };
    assert.deepEqual(report.warnings, [
      "literal_webhook_url_must_not_contain_secrets:ops",
    ]);
  });

  it("doctor reports a disconnected iMessage account as not ready", async () => {
    const fixture = await configuredFixture(singleIMessageConfig());
    const output = captureIo();

    const exitCode = await runCli(
      ["doctor", "--config", fixture.configPath, "--json"],
      output.io,
      runtime({
        env: fixture.env,
        homeDir: fixture.root,
        inspectIMessage: async () => ({
          ok: false,
          code: "imessage_not_ready",
        }),
      }),
    );

    assert.equal(exitCode, 1);
    assert.equal(output.stderr.length, 0);
    const report = JSON.parse(output.stdout.join("\n")) as {
      ok: boolean;
      destinations: Array<{ id: string; status: string; code: string }>;
      issues: string[];
    };
    assert.equal(report.ok, false);
    assert.deepEqual(report.destinations, [
      {
        id: "phone",
        transport: "imessage",
        status: "error",
        code: "imessage_not_ready",
      },
    ]);
    assert.deepEqual(report.issues, ["destination_not_ready"]);
  });
});

const validStopInput = {
  session_id: "session-cli",
  transcript_path: "/must/not/be/read.jsonl",
  cwd: "/tmp/project",
  hook_event_name: "Stop",
  model: "gpt-5",
  permission_mode: "default",
  turn_id: "turn-cli",
  stop_hook_active: false,
  last_assistant_message: "Implemented the change.",
};

function runtime(overrides: Partial<CliRuntime> = {}): CliRuntime {
  return {
    env: {},
    homeDir: tmpdir(),
    stdin: chunks(""),
    now: () => new Date("2026-07-11T00:00:00.000Z"),
    createId: () => "test-id",
    sendWebhook: async () => ({
      status: "accepted",
      code: "webhook_accepted",
    }),
    sendIMessage: async () => ({
      status: "accepted",
      code: "imsg_accepted",
    }),
    inspectWebhook: async () => ({ ok: true, code: "ready" }),
    inspectIMessage: async () => ({
      ok: true,
      code: "ready",
      version: "0.12.3",
    }),
    ...overrides,
  };
}

function captureIo(): {
  io: CliIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

async function configuredFixture(config: string): Promise<{
  root: string;
  configPath: string;
  legacyStoragePath: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-herald-cli-"));
  const configPath = join(root, "config.toml");
  const legacyStoragePath = join(root, "receipts.ndjson");
  await writeFile(configPath, config, { mode: 0o600 });
  await chmod(root, 0o700);
  return {
    root,
    configPath,
    legacyStoragePath,
    env: {
      CODEX_HERALD_RECEIPTS: legacyStoragePath,
      OPS_WEBHOOK_URL: "https://hooks.example.com/from-env",
    },
  };
}

async function* chunks(value: string): AsyncGenerator<Buffer> {
  yield Buffer.from(value, "utf8");
}

function singleWebhookConfig(): string {
  return `version = 1

[destinations.ops]
transport = "webhook"
url = "$OPS_WEBHOOK_URL"

[[routes]]
events = ["turn.finished"]
destinations = ["ops"]
template = "compact"

[privacy]
include_prompt = false
include_summary = true
max_chars = 500
`;
}

function twoDestinationConfig(): string {
  return `version = 1

[destinations.ops]
transport = "webhook"
url = "$OPS_WEBHOOK_URL"

[destinations.phone]
transport = "imessage"
driver = "imsg"
recipient = "+8613800000000"

[[routes]]
events = ["turn.finished"]
destinations = ["ops", "phone"]
template = "compact"

[privacy]
include_prompt = false
include_summary = true
max_chars = 500
`;
}

function singleIMessageConfig(): string {
  return `version = 1

[destinations.phone]
transport = "imessage"
driver = "imsg"
recipient = "+8613800000000"

[[routes]]
events = ["turn.finished"]
destinations = ["phone"]
template = "compact"

[privacy]
include_prompt = false
include_summary = true
max_chars = 500
`;
}

function literalQueryWebhookConfig(): string {
  return `version = 1

[destinations.ops]
transport = "webhook"
url = "https://hooks.example.com/path?token=canary-query-secret"

[[routes]]
events = ["turn.finished"]
destinations = ["ops"]
template = "compact"

[privacy]
include_prompt = false
include_summary = true
max_chars = 500
`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
