import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HeraldError } from "../domain/errors.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export const DEFAULT_CONFIG = `# Codex Herald user configuration
# This file contains recipient metadata. Keep it private.
version = 1
destinations = {}
routes = []

[privacy]
include_prompt = false
include_summary = true
max_chars = 500

# Add destinations and routes, for example:
# [destinations.ops]
# transport = "webhook"
# url = "$OPS_WEBHOOK_URL"
#
# [[routes]]
# events = ["turn.finished"]
# destinations = ["ops"]
# template = "compact"
`;

export interface SetupConfigOptions {
  force?: boolean;
  imessageRecipient?: string;
}

export async function setupConfig(
  path: string,
  options: SetupConfigOptions = {},
): Promise<"created" | "replaced"> {
  const directory = dirname(path);
  const content = configContent(options.imessageRecipient);
  await ensureSafeDirectory(directory);

  if (!options.force) {
    await createExclusive(path, content);
    return "created";
  }

  const existing = await existingStats(path);
  if (existing) {
    assertReplaceable(path, existing);
  }
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeConfigFile(temporaryPath, content);
    await replacePath(temporaryPath, path);
  } catch (error) {
    await unlinkIfPresent(temporaryPath);
    throw error;
  }

  return existing ? "replaced" : "created";
}

async function createExclusive(path: string, content: string): Promise<void> {
  try {
    await writeConfigFile(path, content);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      const existing = await existingStats(path);
      if (existing) {
        assertReplaceable(path, existing);
      }
      throw new HeraldError("SETUP_EXISTS", `Configuration already exists: ${path}`);
    }
    throw error;
  }
}

async function writeConfigFile(path: string, content: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
    FILE_MODE,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(FILE_MODE);
  } finally {
    await handle.close();
  }
}

function configContent(imessageRecipient: string | undefined): string {
  if (imessageRecipient === undefined) {
    return DEFAULT_CONFIG;
  }
  if (imessageRecipient.length === 0) {
    throw new HeraldError("CONFIG_INVALID", "iMessage recipient cannot be empty");
  }

  return `# Codex Herald user configuration
# This file contains recipient metadata. Keep it private.
version = 1

[destinations.phone]
transport = "imessage"
driver = "imsg"
recipient = ${JSON.stringify(imessageRecipient)}

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

async function replacePath(temporaryPath: string, path: string): Promise<void> {
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    if (!isReplaceError(error)) {
      throw error;
    }
    await unlink(path);
    await rename(temporaryPath, path);
  }
}

async function ensureSafeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new HeraldError("CONFIG_UNSAFE", `Unsafe configuration directory: ${path}`);
  }

  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stats.uid !== currentUid) {
    throw new HeraldError(
      "CONFIG_UNSAFE",
      `Configuration directory is not owned by the current user: ${path}`,
    );
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new HeraldError(
      "CONFIG_UNSAFE",
      `Configuration directory is writable by other users: ${path}`,
    );
  }
}

async function existingStats(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function assertReplaceable(path: string, stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new HeraldError(
      "CONFIG_UNSAFE",
      `Refusing to replace a non-regular configuration file: ${path}`,
    );
  }

  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stats.uid !== currentUid) {
    throw new HeraldError(
      "CONFIG_UNSAFE",
      `Configuration is not owned by the current user: ${path}`,
    );
  }
}

function isReplaceError(error: unknown): boolean {
  return isErrno(error, "EEXIST") || isErrno(error, "EPERM");
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
