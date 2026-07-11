import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HeraldError, isHeraldError } from "../domain/errors.js";
import type { HeraldConfig } from "../domain/types.js";
import { parseConfigText } from "./parse.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

export interface ConfigPathOptions {
  explicitPath?: string;
  env?: ConfigEnvironment;
  homeDir?: string;
}

export interface LoadedConfig {
  path: string;
  config: HeraldConfig;
}

export function resolveConfigPath(options: ConfigPathOptions = {}): string {
  const env = options.env ?? process.env;

  if (options.explicitPath) {
    return options.explicitPath;
  }
  if (env.CODEX_HERALD_CONFIG) {
    if (!isAbsolute(env.CODEX_HERALD_CONFIG)) {
      throw new HeraldError(
        "CONFIG_INVALID",
        "CODEX_HERALD_CONFIG must be an absolute path",
      );
    }
    return env.CODEX_HERALD_CONFIG;
  }
  if (env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)) {
    return join(env.XDG_CONFIG_HOME, "codex-herald", "config.toml");
  }

  const home = options.homeDir || env.HOME || homedir();
  if (!isAbsolute(home)) {
    throw new HeraldError(
      "CONFIG_INVALID",
      "The configuration home directory must be absolute",
    );
  }
  return join(home, ".config", "codex-herald", "config.toml");
}

export async function loadConfig(
  options: ConfigPathOptions = {},
): Promise<LoadedConfig> {
  const path = resolveConfigPath(options);
  let pathStats: Stats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    throw mapFileError(error, path);
  }

  if (pathStats.isSymbolicLink()) {
    throw unsafeConfig(path, "symbolic links are not allowed");
  }
  assertSafeFile(path, pathStats);

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw mapFileError(error, path);
  }

  try {
    const openedStats = await handle.stat();
    assertSafeFile(path, openedStats);
    if (openedStats.dev !== pathStats.dev || openedStats.ino !== pathStats.ino) {
      throw unsafeConfig(path, "the file changed while it was being opened");
    }

    const text = await readBoundedConfig(handle, path);
    return { path, config: parseConfigText(text) };
  } catch (error) {
    if (isHeraldError(error)) {
      throw error;
    }
    throw unsafeConfig(path, "the file could not be read safely");
  } finally {
    await handle.close();
  }
}

async function readBoundedConfig(handle: FileHandle, path: string): Promise<string> {
  const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
  let totalBytes = 0;

  while (totalBytes < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalBytes,
      buffer.length - totalBytes,
      totalBytes,
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytes += bytesRead;
  }

  if (totalBytes > MAX_CONFIG_BYTES) {
    throw unsafeConfig(path, "it exceeds the 1 MiB size limit");
  }

  return buffer.subarray(0, totalBytes).toString("utf8");
}

function assertSafeFile(path: string, stats: Stats): void {
  if (!stats.isFile()) {
    throw unsafeConfig(path, "it is not a regular file");
  }

  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stats.uid !== currentUid) {
    throw unsafeConfig(path, "it is not owned by the current user");
  }

  if ((stats.mode & 0o077) !== 0) {
    throw unsafeConfig(path, "it is accessible by the group or other users");
  }

  if (stats.size > MAX_CONFIG_BYTES) {
    throw unsafeConfig(path, "it exceeds the 1 MiB size limit");
  }
}

function mapFileError(error: unknown, path: string): HeraldError {
  if (isErrno(error) && error.code === "ENOENT") {
    return new HeraldError("CONFIG_NOT_FOUND", `Configuration not found: ${path}`);
  }
  if (isErrno(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
    return unsafeConfig(path, "symbolic links are not allowed");
  }
  return unsafeConfig(path, "the file could not be opened safely");
}

function unsafeConfig(path: string, reason: string): HeraldError {
  return new HeraldError(
    "CONFIG_UNSAFE",
    `Unsafe configuration file ${path}: ${reason}`,
  );
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
