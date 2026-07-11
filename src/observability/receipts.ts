import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ReceiptRepository } from "../core/router.js";
import { HeraldError } from "../domain/errors.js";
import type { DeliveryReceipt } from "../domain/types.js";

export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_RETRY_MS = 10;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_STALE_MS = 30_000;
const DELIVERY_LOCK_MAX_ATTEMPTS = 3_500;
const DELIVERY_LOCK_STALE_MS = 30_000;
const LOCK_INITIALIZATION_STALE_MS = 1_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

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
  return {
    async hasAccepted(eventId, destination) {
      return (await readAcceptedKeys(receiptPath)).has(
        acceptedKey(eventId, destination),
      );
    },
    async append(receipt) {
      await appendReceipt(receipt, receiptPath);
    },
    async withDeliveryLock(eventId, destination, action) {
      return withDeliveryLock(receiptPath, eventId, destination, async () => {
        const fresh = await readAcceptedKeys(receiptPath);
        return action(fresh.has(acceptedKey(eventId, destination)));
      });
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
  return withLock(`${receiptPath}.lock`, action);
}

async function withDeliveryLock<T>(
  receiptPath: string,
  eventId: string,
  destination: string,
  action: () => Promise<T>,
): Promise<T> {
  await ensurePrivateDirectory(receiptPath);
  const digest = createHash("sha256")
    .update(acceptedKey(eventId, destination))
    .digest("hex");
  const lockPath = `${receiptPath}.${digest}.delivery.lock`;
  return withLock(lockPath, action, DELIVERY_LOCK_MAX_ATTEMPTS, DELIVERY_LOCK_STALE_MS);
}

async function withLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  maxAttempts = LOCK_MAX_ATTEMPTS,
  staleMs = LOCK_STALE_MS,
): Promise<T> {
  const lock = await acquireLock(lockPath, maxAttempts, staleMs);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

interface HeldLock {
  release(): Promise<void>;
}

async function acquireLock(
  lockPath: string,
  maxAttempts = LOCK_MAX_ATTEMPTS,
  staleMs = LOCK_STALE_MS,
): Promise<HeldLock> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }

      await removeStaleLockDirectory(lockPath, staleMs);
      await delay(LOCK_RETRY_MS);
      continue;
    }

    await chmod(lockPath, DIRECTORY_MODE);
    const ownerPath = join(lockPath, `owner.${process.pid}.${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        ownerPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
        FILE_MODE,
      );
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
      await handle.chmod(FILE_MODE);
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close();
      await unlinkIfPresent(ownerPath);
      await removeEmptyLockDirectory(lockPath);
      if (hasErrorCode(error, "ENOENT")) {
        await delay(LOCK_RETRY_MS);
        continue;
      }
      throw error;
    }

    return {
      async release() {
        await unlinkIfPresent(ownerPath);
        await removeOwnedLockDirectory(lockPath);
      },
    };
  }

  throw new Error("Timed out waiting for the receipt store lock");
}

async function removeStaleLockDirectory(
  lockPath: string,
  staleMs: number,
): Promise<void> {
  let information: Stats;
  try {
    information = await lstat(lockPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("Receipt lock path must be a regular directory");
  }

  let entries: string[];
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (entries.length === 0) {
    if (
      Date.now() - information.mtimeMs >
      Math.min(staleMs, LOCK_INITIALIZATION_STALE_MS)
    ) {
      await removeEmptyLockDirectory(lockPath);
    }
    return;
  }

  for (const entry of entries) {
    const ownerPath = join(lockPath, entry);
    const ownerPid = parseOwnerPid(entry);
    if (ownerPid !== undefined) {
      if (!isProcessAlive(ownerPid)) {
        await unlinkIfPresent(ownerPath);
      }
      continue;
    }

    try {
      const ownerInformation = await lstat(ownerPath);
      if (Date.now() - ownerInformation.mtimeMs > staleMs) {
        await unlinkIfPresent(ownerPath);
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  await removeEmptyLockDirectory(lockPath);
}

function parseOwnerPid(name: string): number | undefined {
  const match = /^owner\.(\d+)\.[0-9A-Za-z-]+$/u.exec(name);
  if (!match?.[1]) {
    return undefined;
  }
  const pid = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

async function removeOwnedLockDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function removeEmptyLockDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTEMPTY")) {
      throw error;
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
