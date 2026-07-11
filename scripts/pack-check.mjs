import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tempRoot = await mkdtemp(join(tmpdir(), "codex-herald-pack-"));

try {
  const packDirectory = join(tempRoot, "pack");
  const extractDirectory = join(tempRoot, "extract");
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(extractDirectory, { recursive: true }),
  ]);

  const packed = run(npm, ["pack", root, "--ignore-scripts", "--json"], {
    cwd: packDirectory,
  });
  const tarballName = parseTarballName(packed.stdout);
  run("tar", ["-xzf", join(packDirectory, tarballName), "-C", extractDirectory], {
    cwd: tempRoot,
  });

  const packageRoot = join(extractDirectory, "package");
  await Promise.all(
    [
      ".codex-plugin/plugin.json",
      "hooks/hooks.json",
      "package.json",
      "bin/codex-herald",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES",
    ].map((path) => requireRegularFile(join(packageRoot, path))),
  );

  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (packageJson.bin?.[packageJson.name] !== "bin/codex-herald") {
    throw new Error("packed package must declare bin/codex-herald");
  }

  const binPath = join(packageRoot, "bin/codex-herald");
  if (((await lstat(binPath)).mode & 0o111) === 0) {
    throw new Error("packed CLI must be executable");
  }

  const version = run(binPath, ["--version"], { cwd: packageRoot });
  if (version.stdout.trim() !== packageJson.version || version.stderr !== "") {
    throw new Error(
      `packed CLI version mismatch: stdout=${JSON.stringify(version.stdout)} ` +
        `stderr=${JSON.stringify(version.stderr)} expected=${JSON.stringify(packageJson.version)}`,
    );
  }

  const receiptPath = join(tempRoot, "receipts.ndjson");
  const environment = {
    ...process.env,
    HOME: join(tempRoot, "home"),
    XDG_CONFIG_HOME: join(tempRoot, "config"),
    XDG_STATE_HOME: join(tempRoot, "state"),
    CODEX_HERALD_RECEIPTS: receiptPath,
  };
  delete environment.CODEX_HERALD_CONFIG;
  delete environment.PLUGIN_DATA;

  const ingest = run(binPath, ["ingest", "--source", "codex-stop"], {
    cwd: packageRoot,
    env: environment,
    input: `${JSON.stringify({
      session_id: "pack-check-session",
      transcript_path: join(tempRoot, "must-not-be-read.jsonl"),
      cwd: packageRoot,
      hook_event_name: "Stop",
      model: "gpt-5",
      permission_mode: "default",
      turn_id: "pack-check-turn",
      stop_hook_active: false,
      last_assistant_message: "Pack check fixture.",
    })}\n`,
  });
  if (ingest.stdout !== "" || ingest.stderr !== "") {
    throw new Error("packed Stop hook must keep stdout and stderr empty");
  }

  const receipts = (await readFile(receiptPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (
    receipts.length !== 1 ||
    receipts[0]?.status !== "skipped" ||
    receipts[0]?.code !== "not_configured"
  ) {
    throw new Error("packed Stop hook must record skipped/not_configured");
  }

  console.log("Package artifact validation passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
    cwd: options.cwd,
  });

  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with ${result.status}: ${result.stderr || result.stdout}`,
    );
  }

  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function parseTarballName(stdout) {
  const value = JSON.parse(stdout);
  const filename = Array.isArray(value) ? value[0]?.filename : undefined;
  if (
    typeof filename !== "string" ||
    filename !== basename(filename) ||
    !filename.endsWith(".tgz")
  ) {
    throw new Error("npm pack did not return a safe tarball filename");
  }
  return filename;
}

async function requireRegularFile(path) {
  if (!(await lstat(path)).isFile()) {
    throw new Error(`${path} must be a regular file`);
  }
}
