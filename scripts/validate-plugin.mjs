import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const packageJson = await readJson("package.json");
const manifest = await readJson(".codex-plugin/plugin.json");
const hooks = await readJson("hooks/hooks.json");
const pluginRoot = "$" + "{PLUGIN_ROOT}";

await Promise.all(
  [".codex-plugin/plugin.json", "hooks/hooks.json", "bin/codex-herald"].map(
    requireRegularFile,
  ),
);

assert.equal(packageJson.name, "codex-herald");
assert.equal(packageJson.bin?.[packageJson.name], "bin/codex-herald");
for (const path of [".codex-plugin/", "hooks/", "bin/codex-herald"]) {
  assert.ok(packageJson.files?.includes(path), `package files must include ${path}`);
}

assert.equal(manifest.name, packageJson.name);
assert.equal(manifest.version, packageJson.version);
assert.equal(manifest.interface?.displayName, "Herald for Codex");
assert.equal(Object.hasOwn(manifest, "hooks"), false);

assert.deepEqual(hooks, {
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: `"${pluginRoot}/bin/codex-herald" ingest --source codex-stop`,
            commandWindows:
              'node "%PLUGIN_ROOT%\\bin\\codex-herald" ingest --source codex-stop',
            timeout: 60,
            statusMessage: "Routing lifecycle notification",
          },
        ],
      },
    ],
  },
});

console.log("Plugin validation passed.");

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

async function requireRegularFile(path) {
  assert.ok((await lstat(new URL(path, root))).isFile(), `${path} must be a file`);
}
