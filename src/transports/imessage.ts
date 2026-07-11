import type {
  DeliveryOutcome,
  IMessageDestination,
  LifecycleEvent,
  Notification,
} from "../domain/types.js";
import {
  findExecutableOnPath,
  runSafeProcess,
  type SafeProcessResult,
} from "../system/process.js";

export const MAX_IMSG_VERSION_CHARS = 128;

const INSPECTION_TIMEOUT_MS = 5_000;
const REQUIRED_SEND_FLAGS = ["--to", "--text", "--service", "--json"] as const;

export type IMessageInspection =
  | { ok: true; code: "ready"; version: string }
  | {
      ok: false;
      code: "driver_failed" | "driver_invalid_response" | "driver_not_found";
    };

export async function inspectIMessage(
  platform: NodeJS.Platform = process.platform,
): Promise<IMessageInspection> {
  if (platform !== "darwin") {
    return { ok: false, code: "driver_not_found" };
  }

  const executable = await findExecutableOnPath("imsg");
  if (!executable) {
    return { ok: false, code: "driver_not_found" };
  }

  const versionResult = await runSafeProcess(
    executable,
    ["--version"],
    INSPECTION_TIMEOUT_MS,
  );
  const versionFailure = inspectionProcessFailure(versionResult);
  if (versionFailure) {
    return versionFailure;
  }

  const version = boundedFirstLine(versionResult.stdout);
  if (!version || versionResult.stdoutTruncated || versionResult.stderrTruncated) {
    return { ok: false, code: "driver_invalid_response" };
  }

  const helpResult = await runSafeProcess(
    executable,
    ["send", "--help"],
    INSPECTION_TIMEOUT_MS,
  );
  const helpFailure = inspectionProcessFailure(helpResult);
  if (helpFailure) {
    return helpFailure;
  }

  if (helpResult.stdoutTruncated || helpResult.stderrTruncated) {
    return { ok: false, code: "driver_invalid_response" };
  }

  const help = `${helpResult.stdout}\n${helpResult.stderr}`;
  if (!REQUIRED_SEND_FLAGS.every((flag) => help.includes(flag))) {
    return { ok: false, code: "driver_invalid_response" };
  }

  return { ok: true, code: "ready", version };
}

export async function sendIMessage(
  destination: IMessageDestination,
  _event: LifecycleEvent,
  notification: Notification,
  platform: NodeJS.Platform = process.platform,
): Promise<DeliveryOutcome> {
  if (platform !== "darwin") {
    return { status: "failed", code: "driver_not_found" };
  }

  const executable = await findExecutableOnPath("imsg");
  if (!executable) {
    return { status: "failed", code: "driver_not_found" };
  }

  const result = await runSafeProcess(
    executable,
    [
      "send",
      "--to",
      destination.recipient,
      "--text",
      notification.body,
      "--service",
      "imessage",
      "--json",
    ],
    destination.timeoutMs,
  );

  switch (result.kind) {
    case "not_found":
      return { status: "failed", code: "driver_not_found" };
    case "timed_out":
      return { status: "failed", code: "driver_timeout" };
    case "signaled":
      return { status: "failed", code: "driver_terminated" };
    case "failed":
      return { status: "failed", code: "driver_failed" };
    case "exited":
      if (result.exitCode !== 0) {
        return { status: "failed", code: "driver_failed" };
      }
      return isAcceptedResponse(result.stdout, result.stdoutTruncated)
        ? { status: "accepted", code: "imsg_accepted" }
        : { status: "failed", code: "driver_invalid_response" };
  }
}

function isAcceptedResponse(stdout: string, truncated: boolean): boolean {
  if (truncated) {
    return false;
  }

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

function inspectionProcessFailure(
  result: SafeProcessResult,
): Extract<IMessageInspection, { ok: false }> | null {
  if (result.kind === "not_found") {
    return { ok: false, code: "driver_not_found" };
  }
  if (result.kind !== "exited" || result.exitCode !== 0) {
    return { ok: false, code: "driver_failed" };
  }
  return null;
}

function boundedFirstLine(stdout: string): string {
  const firstLine = stdout.split(/\r?\n/u, 1)[0] ?? "";
  const cleaned = firstLine.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return Array.from(cleaned).slice(0, MAX_IMSG_VERSION_CHARS).join("");
}
