import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
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

  const packed = run(npm, ["pack", root, "--ignore-scripts", "--json"], packDirectory);
  const packResult = parsePackResult(packed.stdout);
  const tarballName = packResult.filename;
  if (basename(tarballName) !== tarballName || !tarballName.endsWith(".tgz")) {
    throw new Error("npm pack returned an unsafe tarball filename");
  }

  const tarballPath = join(packDirectory, tarballName);
  const archive = run("tar", ["-tzf", tarballPath], tempRoot);
  validateArchiveEntries(archive.stdout);
  run("tar", ["-xzf", tarballPath, "-C", extractDirectory], tempRoot);

  const packageRoot = await realpath(join(extractDirectory, "package"));
  await Promise.all(
    [
      ".codex-plugin/plugin.json",
      "hooks/hooks.json",
      "package.json",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "examples/config.toml",
      "docs/spec.md",
      "docs/security.md",
      "docs/decisions/0001-local-first-plugin-and-cli.md",
      "docs/decisions/0002-cross-process-delivery-locks.md",
    ].map((path) => requireRegularFile(join(packageRoot, path))),
  );
  const packageJson = await readJson(join(packageRoot, "package.json"));
  const entries = await readdir(packageRoot, { recursive: true });
  if (entries.some((entry) => entry.split(/[\\/]/u).includes("node_modules"))) {
    throw new Error("packed artifact must not contain node_modules");
  }

  const relativeBin = packageJson.bin?.[packageJson.name];
  if (relativeBin !== "bin/codex-herald") {
    throw new Error("packed package must declare bin/codex-herald as its CLI bin");
  }
  const unresolvedBinPath = join(packageRoot, relativeBin);
  const binMetadata = await lstat(unresolvedBinPath);
  if (!binMetadata.isFile() || (binMetadata.mode & 0o111) === 0) {
    throw new Error("packed CLI must be a regular executable file");
  }
  const binPath = await realpath(unresolvedBinPath);

  const version = run(binPath, ["--version"], packageRoot);
  if (version.stdout.trim() !== packageJson.version || version.stderr !== "") {
    throw new Error(
      "packed CLI --version mismatch: " +
        `expected=${JSON.stringify(packageJson.version)} ` +
        `stdout=${JSON.stringify(version.stdout)} ` +
        `stderr=${JSON.stringify(version.stderr)}`,
    );
  }

  for (const args of [["ingest"], ["ingest", "--help"]]) {
    const usage = runResult(binPath, args, packageRoot);
    if (usage.status !== 1 || usage.stdout !== "" || usage.stderr === "") {
      throw new Error(
        `packed ${args.join(" ")} must fail silently on stdout with exit 1: ` +
          `status=${usage.status} stdout=${JSON.stringify(usage.stdout)} ` +
          `stderr=${JSON.stringify(usage.stderr)}`,
      );
    }
  }

  const bundle = await readFile(binPath, "utf8");
  assertNoBareDependencyImports(bundle);

  const receiptPath = join(tempRoot, "receipts.ndjson");
  const isolatedEnvironment = {
    ...process.env,
    HOME: join(tempRoot, "home"),
    XDG_CONFIG_HOME: join(tempRoot, "config"),
    XDG_STATE_HOME: join(tempRoot, "state"),
    CODEX_HERALD_RECEIPTS: receiptPath,
  };
  delete isolatedEnvironment.CODEX_HERALD_CONFIG;
  delete isolatedEnvironment.PLUGIN_DATA;

  const stopFixture = {
    session_id: "pack-check-session",
    transcript_path: join(tempRoot, "must-not-be-read.jsonl"),
    cwd: packageRoot,
    hook_event_name: "Stop",
    model: "gpt-5",
    permission_mode: "default",
    turn_id: "pack-check-turn",
    stop_hook_active: false,
    last_assistant_message: "Pack check fixture.",
  };
  const ingest = run(binPath, ["ingest", "--source", "codex-stop"], packageRoot, {
    env: isolatedEnvironment,
    input: `${JSON.stringify(stopFixture)}\n`,
  });
  if (ingest.stdout !== "" || ingest.stderr !== "") {
    throw new Error(
      "packed Stop hook must be silent: " +
        `stdout=${JSON.stringify(ingest.stdout)} ` +
        `stderr=${JSON.stringify(ingest.stderr)}`,
    );
  }

  const receiptLines = (await readFile(receiptPath, "utf8"))
    .split("\n")
    .filter(Boolean);
  if (receiptLines.length !== 1) {
    throw new Error("missing configuration must produce exactly one receipt");
  }
  const receipt = JSON.parse(receiptLines[0]);
  const expectedReceipt = {
    schemaVersion: 1,
    eventType: "turn.finished",
    destination: null,
    transport: null,
    driver: null,
    status: "skipped",
    code: "not_configured",
  };
  for (const [key, expected] of Object.entries(expectedReceipt)) {
    if (receipt[key] !== expected) {
      throw new Error(
        `unexpected skipped receipt ${key}: ${JSON.stringify(receipt[key])}`,
      );
    }
  }
  if (
    typeof receipt.eventId !== "string" ||
    !/^evt_[a-f0-9]{64}$/u.test(receipt.eventId)
  ) {
    throw new Error("skipped receipt must contain a normalized event id");
  }

  console.log("Package artifact validation passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function run(command, args, cwd, options = {}) {
  const result = runResult(command, args, cwd, options);

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "no output").trim();
    throw new Error(`${command} exited with ${result.status}: ${detail}`);
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

function runResult(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parsePackResult(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack did not return valid JSON");
  }
  const result = Array.isArray(value) ? value[0] : undefined;
  if (!result || typeof result.filename !== "string") {
    throw new Error("npm pack JSON did not contain a filename");
  }
  return result;
}

function validateArchiveEntries(stdout) {
  const entries = stdout.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) {
    throw new Error("packed artifact is empty");
  }
  for (const rawEntry of entries) {
    const entry = rawEntry.replace(/\/$/u, "");
    const segments = entry.split("/");
    if (
      (entry !== "package" && !entry.startsWith("package/")) ||
      segments.includes("..")
    ) {
      throw new Error(`packed artifact contains an unsafe path: ${rawEntry}`);
    }
    if (segments.includes("node_modules")) {
      throw new Error("packed artifact must not contain node_modules");
    }
  }
}

function assertNoBareDependencyImports(bundle) {
  const bareImport =
    /\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["'](?:zod|smol-toml|ipaddr\.js)(?:\/[^"']*)?["']/u;
  const match = bundle.match(bareImport);
  if (match) {
    throw new Error(`packed CLI contains a bare dependency import: ${match[0]}`);
  }
}

async function readJson(path) {
  const contents = await readFile(path, "utf8");
  const value = JSON.parse(contents);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value;
}

async function requireRegularFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    throw new Error(`${path} must be a regular file`);
  }
}
