import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, parse } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  DeliveryOutcome,
  IMessageDestination,
  LifecycleEvent,
  Notification,
} from "../domain/types.js";

const INSPECTION_TIMEOUT_MS = 5_000;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024;
const MAX_VERSION_CHARS = 128;
const OSASCRIPT_EXECUTABLE = "/usr/bin/osascript";
const SAFE_CWD = parse(process.execPath).root;

const IMESSAGE_READINESS_SCRIPT = `
try
  with timeout of 4 seconds
    tell application id "com.apple.MobileSMS"
      set imessageServices to services whose service type is iMessage
      if (count imessageServices) is 0 then return "not_ready"
      set targetService to item 1 of imessageServices
      set serviceEnabled to enabled of targetService
      set serviceConnected to (connection status of targetService is connected)
      if serviceEnabled and serviceConnected then return "ready"
    end tell
  end timeout
  return "not_ready"
on error
  return "check_failed"
end try
`;

export type IMessageReadiness =
  | { ok: true; code: "ready" }
  | {
      ok: false;
      code: "imessage_check_failed" | "imessage_not_ready";
    };

type IMessageReadinessChecker = (
  platform: NodeJS.Platform,
  timeoutMs: number,
) => Promise<IMessageReadiness>;

export type IMessageInspection =
  | { ok: true; code: "ready"; version: string }
  | {
      ok: false;
      code:
        | "driver_failed"
        | "driver_invalid_response"
        | "driver_not_found"
        | "imessage_check_failed"
        | "imessage_not_ready";
    };

export async function inspectIMessage(
  platform: NodeJS.Platform = process.platform,
  checkReadiness: IMessageReadinessChecker = checkIMessageReadiness,
): Promise<IMessageInspection> {
  if (platform !== "darwin") {
    return { ok: false, code: "driver_not_found" };
  }

  const executable = await findImsg();
  if (!executable) {
    return { ok: false, code: "driver_not_found" };
  }

  const result = await runProcess(executable, ["--version"], INSPECTION_TIMEOUT_MS);
  if (result.kind === "not_found") {
    return { ok: false, code: "driver_not_found" };
  }
  if (result.kind !== "exited") {
    return { ok: false, code: "driver_failed" };
  }

  const version = firstLine(result.stdout);
  if (!version) {
    return { ok: false, code: "driver_invalid_response" };
  }

  const readiness = await checkReadiness(platform, INSPECTION_TIMEOUT_MS);
  return readiness.ok
    ? { ok: true, code: "ready", version }
    : { ok: false, code: readiness.code };
}

export async function checkIMessageReadiness(
  platform: NodeJS.Platform = process.platform,
  timeoutMs = INSPECTION_TIMEOUT_MS,
  run: ProcessRunner = runProcess,
): Promise<IMessageReadiness> {
  if (platform !== "darwin") {
    return { ok: false, code: "imessage_check_failed" };
  }

  const result = await run(
    OSASCRIPT_EXECUTABLE,
    ["-e", IMESSAGE_READINESS_SCRIPT],
    timeoutMs,
  );
  if (result.kind !== "exited") {
    return { ok: false, code: "imessage_check_failed" };
  }

  switch (firstLine(result.stdout)) {
    case "ready":
      return { ok: true, code: "ready" };
    case "not_ready":
      return { ok: false, code: "imessage_not_ready" };
    default:
      return { ok: false, code: "imessage_check_failed" };
  }
}

export async function sendIMessage(
  destination: IMessageDestination,
  _event: LifecycleEvent,
  notification: Notification,
  platform: NodeJS.Platform = process.platform,
  checkReadiness: IMessageReadinessChecker = checkIMessageReadiness,
): Promise<DeliveryOutcome> {
  if (platform !== "darwin") {
    return { status: "failed", code: "driver_not_found" };
  }

  const executable = await findImsg();
  if (!executable) {
    return { status: "failed", code: "driver_not_found" };
  }

  const startedAt = performance.now();
  const readiness = await checkReadiness(
    platform,
    Math.min(INSPECTION_TIMEOUT_MS, destination.timeoutMs),
  );
  if (!readiness.ok) {
    return { status: "failed", code: readiness.code };
  }

  const remainingTimeoutMs = Math.floor(
    destination.timeoutMs - (performance.now() - startedAt),
  );
  if (remainingTimeoutMs <= 0) {
    return { status: "failed", code: "driver_timeout" };
  }

  const result = await runProcess(
    executable,
    [
      "send",
      "--to",
      destination.recipient,
      "--text",
      `${notification.title}\n${notification.body}`,
      "--service",
      "imessage",
      "--json",
    ],
    remainingTimeoutMs,
  );

  switch (result.kind) {
    case "not_found":
      return { status: "failed", code: "driver_not_found" };
    case "timed_out":
      return { status: "failed", code: "driver_timeout" };
    case "terminated":
      return { status: "failed", code: "driver_terminated" };
    case "failed":
      return { status: "failed", code: "driver_failed" };
    case "exited":
      return isAcceptedResponse(result.stdout)
        ? { status: "accepted", code: "imsg_accepted" }
        : { status: "failed", code: "driver_invalid_response" };
  }
}

async function findImsg(searchPath = process.env.PATH): Promise<string | null> {
  if (!searchPath) {
    return null;
  }

  for (const directory of searchPath.split(delimiter)) {
    if (!isAbsolute(directory)) {
      continue;
    }

    try {
      const executable = await realpath(join(directory, "imsg"));
      if (!(await stat(executable)).isFile()) {
        continue;
      }
      await access(executable, fsConstants.X_OK);
      return executable;
    } catch {
      // PATH is an explicit user trust boundary; keep scanning silently.
    }
  }

  return null;
}

type ProcessResult =
  | { kind: "exited"; stdout: string }
  | { kind: "failed" | "not_found" | "terminated" | "timed_out"; stdout: "" };

type ProcessRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<ProcessResult>;

function runProcess(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        cwd: SAFE_CWD,
        encoding: "utf8",
        env: childEnvironment(),
        killSignal: "SIGKILL",
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        shell: false,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        if (!error) {
          resolve({ kind: "exited", stdout });
          return;
        }

        if (isErrorCode(error, "ENOENT")) {
          resolve({ kind: "not_found", stdout: "" });
        } else if (error.killed && error.signal === "SIGKILL") {
          resolve({ kind: "timed_out", stdout: "" });
        } else if (error.signal) {
          resolve({ kind: "terminated", stdout: "" });
        } else {
          resolve({ kind: "failed", stdout: "" });
        }
      },
    );
  });
}

function isAcceptedResponse(stdout: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return false;
  }

  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "status" in value &&
    value.status === "sent"
  );
}

function firstLine(stdout: string): string {
  const value = stdout.split(/\r?\n/u, 1)[0] ?? "";
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return Array.from(cleaned).slice(0, MAX_VERSION_CHARS).join("");
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const name of ["HOME", "LANG", "LC_ALL", "TMPDIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
