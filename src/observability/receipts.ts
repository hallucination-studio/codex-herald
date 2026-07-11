import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ReceiptRepository } from "../core/router.js";
import { HeraldError } from "../domain/errors.js";
import type { DeliveryReceipt } from "../domain/types.js";

export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const receiptQueues = new Map<string, Promise<void>>();

export function resolveReceiptPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const override = nonEmpty(environment.CODEX_HERALD_RECEIPTS);
  if (override !== undefined) {
    return requireAbsolutePath(override, "CODEX_HERALD_RECEIPTS");
  }

  const pluginData = nonEmpty(environment.PLUGIN_DATA);
  if (pluginData !== undefined) {
    return join(requireAbsolutePath(pluginData, "PLUGIN_DATA"), "receipts.ndjson");
  }

  const xdgState = nonEmpty(environment.XDG_STATE_HOME);
  const stateDirectory =
    xdgState && isAbsolute(xdgState)
      ? xdgState
      : join(requireAbsolutePath(homeDirectory, "home directory"), ".local", "state");
  return join(stateDirectory, "codex-herald", "receipts.ndjson");
}

function requireAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) {
    throw new HeraldError("CONFIG_INVALID", `${name} must be an absolute path`);
  }
  return value;
}

export function acceptedKey(eventId: string, destination: string): string {
  return JSON.stringify([eventId, destination]);
}

export async function appendReceipt(
  receipt: DeliveryReceipt,
  receiptPath = resolveReceiptPath(),
): Promise<void> {
  const line = `${JSON.stringify(persistedReceipt(receipt))}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > RECEIPT_MAX_BYTES) {
    throw new RangeError("Receipt exceeds the maximum receipt file size");
  }

  await ensurePrivateDirectory(receiptPath);
  await withReceiptLock(receiptPath, async () => {
    const currentSize = await privateRegularFileSize(receiptPath);
    if (currentSize + lineBytes > RECEIPT_MAX_BYTES) {
      await rotateReceiptFile(receiptPath);
    }

    const handle = await open(
      receiptPath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | NO_FOLLOW,
      FILE_MODE,
    );
    try {
      const information = await handle.stat();
      if (!information.isFile()) {
        throw new Error("Receipt path is not a regular file");
      }
      await handle.chmod(FILE_MODE);
      await handle.writeFile(line, "utf8");
    } finally {
      await handle.close();
    }
  });
}

export async function readAcceptedKeys(
  receiptPath = resolveReceiptPath(),
): Promise<Set<string>> {
  await ensurePrivateDirectory(receiptPath);
  return withReceiptLock(receiptPath, async () => {
    const keys = new Set<string>();
    for (const path of [`${receiptPath}.1`, receiptPath]) {
      const contents = await readPrivateFile(path);
      if (contents === undefined) {
        continue;
      }

      for (const line of contents.split("\n")) {
        const accepted = parseAcceptedReceipt(line);
        if (accepted !== undefined) {
          keys.add(acceptedKey(accepted.eventId, accepted.destination));
        }
      }
    }
    return keys;
  });
}

export function createReceiptRepository(
  receiptPath = resolveReceiptPath(),
): ReceiptRepository {
  let acceptedKeys: Promise<Set<string>> | undefined;
  const loadAcceptedKeys = () => {
    acceptedKeys ??= readAcceptedKeys(receiptPath);
    return acceptedKeys;
  };

  return {
    async hasAccepted(eventId, destination) {
      return (await loadAcceptedKeys()).has(acceptedKey(eventId, destination));
    },
    async append(receipt) {
      await appendReceipt(receipt, receiptPath);
      if (acceptedKeys && receipt.status === "accepted" && receipt.destination) {
        try {
          (await acceptedKeys).add(acceptedKey(receipt.eventId, receipt.destination));
        } catch {
          // A failed best-effort lookup must not turn a recorded send into failure.
        }
      }
    },
  };
}

function persistedReceipt(receipt: DeliveryReceipt): DeliveryReceipt {
  const base = {
    schemaVersion: receipt.schemaVersion,
    eventId: receipt.eventId,
    eventType: receipt.eventType,
    destination: receipt.destination,
    transport: receipt.transport,
    driver: receipt.driver,
    recordedAt: receipt.recordedAt,
    durationMs: receipt.durationMs,
  };

  switch (receipt.status) {
    case "accepted":
      return { ...base, status: receipt.status, code: receipt.code };
    case "failed":
      return { ...base, status: receipt.status, code: receipt.code };
    case "skipped":
      return { ...base, status: receipt.status, code: receipt.code };
  }
}

async function ensurePrivateDirectory(receiptPath: string): Promise<void> {
  const directory = dirname(receiptPath);
  let created = false;
  try {
    created =
      (await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })) !== undefined;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }

  const information = await lstat(directory);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("Receipt path parent must be a regular directory");
  }

  if (created) {
    await chmod(directory, DIRECTORY_MODE);
    return;
  }

  if ((information.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error("Existing receipt directory must be private with mode 0700");
  }
}

async function privateRegularFileSize(path: string): Promise<number> {
  let information: Stats;
  try {
    information = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }

  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error("Receipt path is not a regular file");
  }

  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    await handle.chmod(FILE_MODE);
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

async function rotateReceiptFile(receiptPath: string): Promise<void> {
  const rotatedPath = `${receiptPath}.1`;
  try {
    await rename(receiptPath, rotatedPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    if (!hasErrorCode(error, "EEXIST") && !hasErrorCode(error, "EPERM")) {
      throw error;
    }

    await unlinkIfPresent(rotatedPath);
    await rename(receiptPath, rotatedPath);
  }
}

async function readPrivateFile(path: string): Promise<string | undefined> {
  let information: Stats;
  try {
    information = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  if (!information.isFile() || information.isSymbolicLink()) {
    return undefined;
  }

  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseAcceptedReceipt(
  line: string,
): { eventId: string; destination: string } | undefined {
  if (line.trim() === "") {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.schemaVersion !== 1 ||
    value.eventType !== "turn.finished" ||
    value.status !== "accepted" ||
    typeof value.eventId !== "string" ||
    value.eventId.length === 0 ||
    typeof value.destination !== "string" ||
    value.destination.length === 0
  ) {
    return undefined;
  }

  const webhookAccepted =
    value.transport === "webhook" &&
    value.driver === "node-http" &&
    value.code === "webhook_accepted";
  const imessageAccepted =
    value.transport === "imessage" &&
    value.driver === "imsg" &&
    value.code === "imsg_accepted";
  if (!webhookAccepted && !imessageAccepted) {
    return undefined;
  }

  return { eventId: value.eventId, destination: value.destination };
}

async function withReceiptLock<T>(
  receiptPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = receiptQueues.get(receiptPath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  receiptQueues.set(receiptPath, tail);

  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (receiptQueues.get(receiptPath) === tail) {
      receiptQueues.delete(receiptPath);
    }
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
