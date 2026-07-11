import { spawn } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, parse } from "node:path";
import type { Readable } from "node:stream";

export const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024;
export const SAFE_PROCESS_CWD = parse(process.execPath).root;

export type SafeProcessKind =
  | "exited"
  | "failed"
  | "not_found"
  | "signaled"
  | "timed_out";

export interface SafeProcessResult {
  kind: SafeProcessKind;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export async function findExecutableOnPath(
  name: string,
  searchPath = process.env.PATH,
): Promise<string | null> {
  if (!/^[0-9A-Za-z._-]+$/u.test(name) || !searchPath) {
    return null;
  }

  for (const directory of searchPath.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) {
      continue;
    }

    try {
      const resolvedDirectory = await realpath(directory);
      const directoryMetadata = await stat(resolvedDirectory);
      if (!isTrustedPathEntry(directoryMetadata, "directory")) {
        continue;
      }

      const resolved = await realpath(join(resolvedDirectory, name));
      const metadata = await stat(resolved);
      if (!isTrustedPathEntry(metadata, "file")) {
        continue;
      }
      await access(resolved, fsConstants.X_OK);
      return resolved;
    } catch {
      // Continue scanning without exposing PATH contents or filesystem errors.
    }
  }

  return null;
}

function isTrustedPathEntry(metadata: Stats, kind: "directory" | "file"): boolean {
  if (kind === "directory" ? !metadata.isDirectory() : !metadata.isFile()) {
    return false;
  }

  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== 0 && metadata.uid !== currentUid) {
    return false;
  }

  if (process.platform === "win32") {
    return true;
  }
  if ((metadata.mode & 0o002) !== 0) {
    return false;
  }
  if ((metadata.mode & 0o020) === 0) {
    return true;
  }
  return kind === "directory" && metadata.uid !== 0;
}

export function runSafeProcess(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<SafeProcessResult> {
  return new Promise((resolve) => {
    if (!isAbsolute(executable)) {
      resolve(emptyResult("failed"));
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], {
        cwd: SAFE_PROCESS_CWD,
        env: safeChildEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve(emptyResult(isEnoent(error) ? "not_found" : "failed"));
      return;
    }

    const stdout = captureStream(child.stdout);
    const stderr = captureStream(child.stderr);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (
      kind: SafeProcessKind,
      exitCode: number | null = null,
      signal: NodeJS.Signals | null = null,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        kind,
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
      });
    };

    child.once("error", (error) => {
      finish(isEnoent(error) ? "not_found" : "failed");
    });

    child.once("close", (code, signal) => {
      if (signal) {
        finish("signaled", null, signal);
      } else if (typeof code === "number") {
        finish("exited", code);
      } else {
        finish("failed");
      }
    });

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The timeout outcome is authoritative even if the process already ended.
      }
      finish("timed_out");
    }, timeoutMs);
    timer.unref();
  });
}

interface StreamCapture {
  text(): string;
  truncated(): boolean;
}

function captureStream(stream: Readable | null): StreamCapture {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let wasTruncated = false;

  stream?.on("data", (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = MAX_PROCESS_OUTPUT_BYTES - bytes;
    if (remaining > 0) {
      const captured = chunk.subarray(0, remaining);
      chunks.push(captured);
      bytes += captured.byteLength;
    }
    if (chunk.byteLength > remaining) {
      wasTruncated = true;
    }
  });

  return {
    text: () => Buffer.concat(chunks, bytes).toString("utf8"),
    truncated: () => wasTruncated,
  };
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const name of ["HOME", "LANG", "LC_ALL", "TMPDIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function emptyResult(kind: SafeProcessKind): SafeProcessResult {
  return {
    kind,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
