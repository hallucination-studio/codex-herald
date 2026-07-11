import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  const configPath = join(tempRoot, "config", "config.toml");
  const legacyReceiptPath = join(tempRoot, "receipts.ndjson");
  const pluginDataPath = join(tempRoot, "plugin-data");
  const statePath = join(tempRoot, "state");
  const homePath = join(tempRoot, "home");
  const runtimeStatePaths = [
    legacyReceiptPath,
    pluginDataPath,
    join(statePath, "codex-herald"),
    join(homePath, ".local", "state", "codex-herald"),
  ];
  const environment = {
    ...process.env,
    HOME: homePath,
    XDG_CONFIG_HOME: join(tempRoot, "xdg-config"),
    XDG_STATE_HOME: statePath,
    PLUGIN_DATA: pluginDataPath,
    CODEX_HERALD_RECEIPTS: legacyReceiptPath,
  };
  delete environment.CODEX_HERALD_CONFIG;
  delete environment.CODEX_HERALD_PACK_CHECK_URL;

  await mkdir(join(tempRoot, "config"), { recursive: true });
  await writeFile(
    configPath,
    `version = 1

[destinations.ops]
transport = "webhook"
url = "$CODEX_HERALD_PACK_CHECK_URL"

[[routes]]
events = ["turn.finished"]
destinations = ["ops"]
template = "compact"

[privacy]
include_prompt = false
include_summary = true
max_chars = 500
`,
    { mode: 0o600 },
  );

  const ingest = run(
    binPath,
    ["ingest", "--source", "codex-stop", "--config", configPath],
    {
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
    },
  );
  const ingestOutput = JSON.parse(ingest.stdout);
  if (
    ingest.stderr !== "" ||
    typeof ingestOutput.systemMessage !== "string" ||
    !ingestOutput.systemMessage.includes("secret_unavailable") ||
    ingestOutput.systemMessage.includes("Pack check fixture.")
  ) {
    throw new Error("packed ingest must emit one non-blocking redacted warning");
  }
  await requireNoRuntimeState(runtimeStatePaths);

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

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
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

async function requireNoRuntimeState(paths) {
  for (const path of paths) {
    try {
      await lstat(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    throw new Error(`packed ingest must not create runtime state at ${path}`);
  }
}

function hasErrorCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
