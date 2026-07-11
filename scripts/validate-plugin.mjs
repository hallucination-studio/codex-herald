import { lstat, readFile } from "node:fs/promises";

const errors = [];

const PACKAGE_NAME = "codex-herald";
const DISPLAY_NAME = "Herald for Codex";
const MANIFEST_PATH = ".codex-plugin/plugin.json";
const HOOKS_PATH = "hooks/hooks.json";
const BIN_PATH = "bin/codex-herald";
const PLUGIN_ROOT_VARIABLE = "$" + "{PLUGIN_ROOT}";
const STOP_COMMAND = `"${PLUGIN_ROOT_VARIABLE}/bin/codex-herald" ingest --source codex-stop`;
const STOP_COMMAND_WINDOWS =
  'node "%PLUGIN_ROOT%\\bin\\codex-herald" ingest --source codex-stop';
const STOP_TIMEOUT_SECONDS = 60;
const STOP_STATUS_MESSAGE = "Routing lifecycle notification";
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const [packageJson, manifest, hookConfig] = await Promise.all([
  readJson("package.json"),
  readJson(MANIFEST_PATH),
  readJson(HOOKS_PATH),
]);

await Promise.all([
  requireFile(MANIFEST_PATH),
  requireFile(HOOKS_PATH),
  requireFile(BIN_PATH),
]);

if (packageJson && manifest && hookConfig) {
  validatePackage(packageJson);
  validateManifest(packageJson, manifest);
  validateHooks(hookConfig);
}

if (errors.length > 0) {
  console.error("Plugin validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log("Plugin validation passed.");
}

async function readJson(relativePath) {
  try {
    const contents = await readFile(
      new URL(`../${relativePath}`, import.meta.url),
      "utf8",
    );
    const value = JSON.parse(contents);
    if (!isRecord(value)) {
      errors.push(`${relativePath} must contain a JSON object`);
      return null;
    }
    return value;
  } catch (error) {
    errors.push(
      error instanceof SyntaxError
        ? `${relativePath} must contain valid JSON`
        : `unable to read ${relativePath}`,
    );
    return null;
  }
}

async function requireFile(relativePath) {
  try {
    const metadata = await lstat(new URL(`../${relativePath}`, import.meta.url));
    if (!metadata.isFile()) {
      errors.push(`${relativePath} must be a regular file`);
    }
  } catch {
    errors.push(`missing ${relativePath}`);
  }
}

function validatePackage(packageJson) {
  expectEqual(packageJson.name, PACKAGE_NAME, "package.json name");
  expectEqual(
    packageJson.bin?.[PACKAGE_NAME],
    BIN_PATH,
    `package.json bin.${PACKAGE_NAME}`,
  );

  const packagedFiles = packageJson.files;
  if (!Array.isArray(packagedFiles)) {
    errors.push("package.json files must be an array");
    return;
  }

  for (const path of [".codex-plugin/", "hooks/", BIN_PATH]) {
    if (!packagedFiles.includes(path)) {
      errors.push(`package.json files must include ${path}`);
    }
  }
}

function validateManifest(packageJson, manifest) {
  expectEqual(manifest.name, PACKAGE_NAME, `${MANIFEST_PATH} name`);
  expectEqual(
    manifest.interface?.displayName,
    DISPLAY_NAME,
    `${MANIFEST_PATH} interface.displayName`,
  );
  expectEqual(manifest.version, packageJson.version, "plugin and package versions");

  if (typeof manifest.version !== "string" || !STRICT_SEMVER.test(manifest.version)) {
    errors.push(`${MANIFEST_PATH} version must be strict semver`);
  }
  if (Object.hasOwn(manifest, "hooks")) {
    errors.push(
      `${MANIFEST_PATH} must use default ${HOOKS_PATH} discovery, not a hooks field`,
    );
  }
}

function validateHooks(hookConfig) {
  if (!isRecord(hookConfig.hooks)) {
    errors.push(`${HOOKS_PATH} hooks must be an object`);
    return;
  }

  expectEqual(Object.keys(hookConfig.hooks), ["Stop"], `${HOOKS_PATH} hook names`);

  const stopGroups = hookConfig.hooks.Stop;
  if (!Array.isArray(stopGroups) || stopGroups.length !== 1) {
    errors.push(`${HOOKS_PATH} Stop must contain exactly one hook group`);
    return;
  }

  const group = stopGroups[0];
  if (!isRecord(group)) {
    errors.push(`${HOOKS_PATH} Stop hook group must be an object`);
    return;
  }
  if (Object.hasOwn(group, "matcher")) {
    errors.push(`${HOOKS_PATH} Stop hook must not declare a matcher`);
  }

  const hooks = group.hooks;
  if (!Array.isArray(hooks) || hooks.length !== 1 || !isRecord(hooks[0])) {
    errors.push(`${HOOKS_PATH} Stop must contain exactly one command hook`);
    return;
  }

  const hook = hooks[0];
  expectEqual(hook.type, "command", `${HOOKS_PATH} Stop hook type`);
  expectEqual(hook.command, STOP_COMMAND, `${HOOKS_PATH} Stop hook command`);
  expectEqual(hook.timeout, STOP_TIMEOUT_SECONDS, `${HOOKS_PATH} Stop hook timeout`);
  expectEqual(
    hook.commandWindows,
    STOP_COMMAND_WINDOWS,
    `${HOOKS_PATH} Stop hook commandWindows`,
  );
  expectEqual(
    hook.statusMessage,
    STOP_STATUS_MESSAGE,
    `${HOOKS_PATH} Stop hook statusMessage`,
  );
}

function expectEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(
      `${label} must be ${JSON.stringify(expected)} (received ${JSON.stringify(actual)})`,
    );
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
