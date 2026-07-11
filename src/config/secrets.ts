import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { HeraldError } from "../domain/errors.js";
import type { ResolvableValue, SecretReference } from "../domain/types.js";

const KEYCHAIN_TIMEOUT_MS = 5_000;
const KEYCHAIN_OUTPUT_LIMIT = 16 * 1024;

export interface SecretDependencies {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  readKeychain(service: string, account: string, signal?: AbortSignal): Promise<string>;
}

export async function resolveValue(
  value: ResolvableValue,
  dependencies: SecretDependencies = defaultDependencies(),
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return value.kind === "literal"
    ? value.value
    : resolveSecret(value, dependencies, signal);
}

export async function resolveSecret(
  reference: SecretReference,
  dependencies: SecretDependencies = defaultDependencies(),
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (reference.kind === "env") {
    const value = dependencies.env[reference.name];
    if (value === undefined || value.length === 0) {
      throw unavailable("Environment secret is not configured");
    }
    return value;
  }

  if (dependencies.platform !== "darwin") {
    throw unavailable("Keychain secrets are only available on macOS");
  }

  let value: string;
  try {
    value = await dependencies.readKeychain(
      reference.service,
      reference.account,
      signal,
    );
    signal?.throwIfAborted();
  } catch {
    throw unavailable("Keychain secret is unavailable");
  }

  const normalized = value.replace(/[\r\n]+$/u, "");
  if (normalized.length === 0) {
    throw unavailable("Keychain secret is empty");
  }
  return normalized;
}

export function defaultDependencies(): SecretDependencies {
  return {
    env: process.env,
    platform: process.platform,
    readKeychain: readMacKeychain,
  };
}

function unavailable(message: string): HeraldError {
  return new HeraldError("SECRET_UNAVAILABLE", message);
}

function readMacKeychain(
  service: string,
  account: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      {
        cwd: homedir(),
        encoding: "utf8",
        env: minimalEnvironment(),
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: KEYCHAIN_OUTPUT_LIMIT,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Keychain lookup failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["HOME", "LANG", "LC_ALL", "LOGNAME", "TMPDIR", "USER"];
  const env: NodeJS.ProcessEnv = {};

  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }

  return env;
}
