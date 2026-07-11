import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readLimitedText } from "./cli/input.js";
import {
  type ConfigPathOptions,
  loadConfig,
  resolveConfigPath,
  setupConfig,
} from "./config/index.js";
import {
  defaultDependencies as defaultSecretDependencies,
  resolveSecret,
  resolveValue,
} from "./config/secrets.js";
import {
  MAX_CODEX_STOP_INPUT_BYTES,
  normalizeCodexStop,
  parseCodexStopText,
} from "./core/normalize.js";
import { applyPrivacy } from "./core/privacy.js";
import { routeEvent } from "./core/router.js";
import { HeraldError, isHeraldError } from "./domain/errors.js";
import type {
  DeliveryDependencies,
  DeliveryReceipt,
  LifecycleEvent,
  Notification,
  WebhookDestination,
} from "./domain/types.js";
import {
  appendReceipt,
  createReceiptRepository,
  resolveReceiptPath,
} from "./observability/receipts.js";
import {
  type IMessageInspection,
  inspectIMessage,
  sendIMessage,
} from "./transports/imessage.js";
import {
  inspectWebhook,
  sendWebhook,
  type WebhookInspection,
  type WebhookRuntime,
} from "./transports/webhook.js";

const VERSION = "0.1.0";
const TEST_NOTIFICATION_BODY = "Test notification from Codex Herald.";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliRuntime {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  stdin: AsyncIterable<Uint8Array | string>;
  now(): Date;
  createId(): string;
  sendWebhook: DeliveryDependencies["sendWebhook"];
  sendIMessage: DeliveryDependencies["sendIMessage"];
  inspectWebhook(destination: WebhookDestination): Promise<WebhookInspection>;
  inspectIMessage(): Promise<IMessageInspection>;
}

interface DoctorDestination {
  id: string;
  transport: "imessage" | "webhook";
  status: "ready" | "error";
  code: string;
  version?: string;
}

interface DoctorReport {
  ok: boolean;
  config: {
    path: string;
    status: "ready" | "error";
    code: string;
  };
  receipts: { path: string };
  destinations: DoctorDestination[];
  issues: string[];
  warnings: string[];
  codex: {
    hookTrust: "manual_check";
    instruction: string;
  };
}

const HELP = `Usage:
  codex-herald setup [--config <path>] [--force]
  codex-herald test <destination> [--config <path>] [--json]
  codex-herald doctor [--config <path>] [--json]
  codex-herald ingest --source codex-stop [--config <path>]

Options:
  -h, --help     Show help
  -v, --version  Show version`;

export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
  runtime: CliRuntime = createDefaultRuntime(),
): Promise<number> {
  const [command, ...args] = argv;
  const isIngest = command === "ingest";

  if (
    argv.length === 0 ||
    (!isIngest && (argv.includes("--help") || argv.includes("-h")))
  ) {
    io.stdout(HELP);
    return 0;
  }

  if (!isIngest && (argv.includes("--version") || argv.includes("-v"))) {
    io.stdout(VERSION);
    return 0;
  }

  try {
    switch (command) {
      case "setup":
        return await runSetup(args, io, runtime);
      case "test":
        return await runDestinationTest(args, io, runtime);
      case "doctor":
        return await runDoctor(args, io, runtime);
      case "ingest":
        return await runIngest(args, runtime);
      default:
        throw new CliUsageError(`Unknown command: ${command ?? ""}`);
    }
  } catch (error) {
    if (isUsageError(error)) {
      io.stderr("Invalid arguments. Run codex-herald --help.");
      return isIngest ? 1 : 2;
    }

    io.stderr(isIngest ? formatIngestError(error) : formatError(error));
    return 1;
  }
}

function createDefaultRuntime(): CliRuntime {
  const secretDependencies = defaultSecretDependencies();
  const webhookRuntime: WebhookRuntime = {
    resolveValue: (value, signal) => resolveValue(value, secretDependencies, signal),
    resolveSecret: (reference, signal) =>
      resolveSecret(reference, secretDependencies, signal),
  };

  return {
    env: process.env,
    homeDir: homedir(),
    stdin: process.stdin,
    now: () => new Date(),
    createId: randomUUID,
    sendWebhook: (destination, event, notification) =>
      sendWebhook(destination, event, notification, webhookRuntime),
    sendIMessage,
    inspectWebhook: (destination) => inspectWebhook(destination, webhookRuntime),
    inspectIMessage,
  };
}

async function runSetup(
  args: readonly string[],
  io: CliIo,
  runtime: CliRuntime,
): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      config: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const path = resolveConfigPath(configPathOptions(values.config, runtime));
  const result = await setupConfig(path, { force: values.force });
  io.stdout(`Configuration ${result}: ${path}`);
  io.stdout("Edit destinations and routes, then run codex-herald doctor.");
  return 0;
}

async function runIngest(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      source: { type: "string" },
      config: { type: "string" },
    },
  });
  if (values.source !== "codex-stop") {
    throw new CliUsageError("ingest requires --source codex-stop");
  }

  const inputText = await readLimitedText(runtime.stdin, MAX_CODEX_STOP_INPUT_BYTES);
  const input = parseCodexStopText(inputText);
  const event = normalizeCodexStop(input, runtime.now());
  const receiptPath = resolveReceiptPath(runtime.env, runtime.homeDir);

  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(configPathOptions(values.config, runtime));
  } catch (error) {
    if (isHeraldError(error) && error.code === "CONFIG_NOT_FOUND") {
      await appendReceipt(notConfiguredReceipt(event, runtime.now()), receiptPath);
      return 0;
    }
    throw error;
  }

  const notification = applyPrivacy(event, loaded.config.privacy);
  await routeEvent(
    loaded.config,
    event,
    notification,
    deliveryDependencies(runtime),
    createReceiptRepository(receiptPath),
  );
  return 0;
}

async function runDestinationTest(
  args: readonly string[],
  io: CliIo,
  runtime: CliRuntime,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1 || !positionals[0]) {
    throw new CliUsageError("test requires one destination");
  }

  const loaded = await loadConfig(configPathOptions(values.config, runtime));
  const destinationId = positionals[0];
  if (!loaded.config.destinations[destinationId]) {
    throw new HeraldError(
      "DESTINATION_NOT_FOUND",
      `Unknown destination: ${destinationId}`,
    );
  }

  const event: LifecycleEvent = {
    id: `evt_test_${runtime.createId()}`,
    type: "turn.finished",
    source: "codex",
    sourceEvent: "Stop",
    occurredAt: runtime.now().toISOString(),
    summary: TEST_NOTIFICATION_BODY,
  };
  const notification: Notification = {
    title: "Codex Herald test",
    body: TEST_NOTIFICATION_BODY,
    severity: "info",
    truncated: false,
  };
  const config = {
    ...loaded.config,
    routes: [
      {
        events: ["turn.finished" as const],
        destinations: [destinationId],
        template: "compact" as const,
      },
    ],
  };
  const [receipt] = await routeEvent(
    config,
    event,
    notification,
    deliveryDependencies(runtime),
    createReceiptRepository(resolveReceiptPath(runtime.env, runtime.homeDir)),
  );
  if (!receipt) {
    throw new Error("Destination test produced no receipt");
  }

  if (values.json) {
    io.stdout(JSON.stringify(receipt));
  } else {
    io.stdout(`${destinationId}: ${receipt.status} (${receipt.code})`);
    io.stdout(
      "accepted means the local transport accepted the request; it is not proof of delivery.",
    );
  }
  return receipt.status === "accepted" ? 0 : 1;
}

async function runDoctor(
  args: readonly string[],
  io: CliIo,
  runtime: CliRuntime,
): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const configOptions = configPathOptions(values.config, runtime);
  const path = resolveConfigPath(configOptions);
  const baseReport = {
    receipts: { path: resolveReceiptPath(runtime.env, runtime.homeDir) },
    codex: {
      hookTrust: "manual_check" as const,
      instruction: "Run /hooks in Codex and trust the codex-herald Stop hook.",
    },
  };

  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(configOptions);
  } catch (error) {
    const report: DoctorReport = {
      ok: false,
      config: {
        path,
        status: "error",
        code: isHeraldError(error) ? error.code.toLowerCase() : "internal_error",
      },
      destinations: [],
      issues: ["config_unavailable"],
      warnings: [],
      ...baseReport,
    };
    renderDoctor(report, values.json, io);
    return 1;
  }

  const configuredDestinations = Object.values(loaded.config.destinations);
  const destinations = await Promise.all(
    configuredDestinations.map(async (destination) => {
      if (destination.transport === "webhook") {
        const result = await runtime.inspectWebhook(destination);
        return {
          id: destination.id,
          transport: destination.transport,
          status: result.ok ? "ready" : "error",
          code: result.code,
        } satisfies DoctorDestination;
      }

      const result = await runtime.inspectIMessage();
      return {
        id: destination.id,
        transport: destination.transport,
        status: result.ok ? "ready" : "error",
        code: result.code,
        ...(result.ok ? { version: result.version } : {}),
      } satisfies DoctorDestination;
    }),
  );
  const issues: string[] = [];
  const warnings = configuredDestinations
    .filter(
      (destination) =>
        destination.transport === "webhook" && destination.url.kind === "literal",
    )
    .map(
      (destination) => `literal_webhook_url_must_not_contain_secrets:${destination.id}`,
    );
  if (destinations.length === 0) {
    issues.push("no_destinations");
  }
  if (loaded.config.routes.length === 0) {
    issues.push("no_routes");
  }
  if (destinations.some(({ status }) => status === "error")) {
    issues.push("destination_not_ready");
  }

  const report: DoctorReport = {
    ok: issues.length === 0,
    config: { path: loaded.path, status: "ready", code: "ready" },
    destinations,
    issues,
    warnings,
    ...baseReport,
  };
  renderDoctor(report, values.json, io);
  return report.ok ? 0 : 1;
}

function renderDoctor(report: DoctorReport, json: boolean, io: CliIo): void {
  if (json) {
    io.stdout(JSON.stringify(report));
    return;
  }

  io.stdout(`Config: ${report.config.status} (${report.config.path})`);
  for (const destination of report.destinations) {
    io.stdout(
      `${destination.id}: ${destination.status} (${destination.code})${
        destination.version ? ` ${destination.version}` : ""
      }`,
    );
  }
  for (const issue of report.issues) {
    io.stdout(`Issue: ${issue}`);
  }
  for (const warning of report.warnings) {
    io.stdout(`Warning: ${warning}`);
  }
  io.stdout(`Receipts: ${report.receipts.path}`);
  io.stdout(`Hook trust: ${report.codex.instruction}`);
}

function deliveryDependencies(runtime: CliRuntime): DeliveryDependencies {
  return {
    now: runtime.now,
    sendWebhook: runtime.sendWebhook,
    sendIMessage: runtime.sendIMessage,
  };
}

function configPathOptions(
  explicitPath: string | undefined,
  runtime: CliRuntime,
): ConfigPathOptions {
  return {
    ...(explicitPath ? { explicitPath } : {}),
    env: runtime.env,
    homeDir: runtime.homeDir,
  };
}

function notConfiguredReceipt(
  event: LifecycleEvent,
  recordedAt: Date,
): DeliveryReceipt {
  return {
    schemaVersion: 1,
    eventId: event.id,
    eventType: event.type,
    destination: null,
    transport: null,
    driver: null,
    status: "skipped",
    code: "not_configured",
    recordedAt: recordedAt.toISOString(),
    durationMs: 0,
  };
}

function formatError(error: unknown): string {
  if (isHeraldError(error)) {
    return `${error.code}: ${error.message}`;
  }
  return "INTERNAL_ERROR: Codex Herald failed";
}

function formatIngestError(error: unknown): string {
  const code = isHeraldError(error) ? error.code : "INTERNAL_ERROR";
  return `${code}: Codex Herald ingest failed`;
}

class CliUsageError extends Error {}

function isUsageError(error: unknown): boolean {
  if (error instanceof CliUsageError) {
    return true;
  }
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS")
  );
}

const defaultIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
