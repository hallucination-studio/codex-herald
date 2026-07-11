import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseConfigText } from "../src/config/index.js";
import { DEFAULT_CONFIG, setupConfig } from "../src/config/setup.js";
import { HeraldError } from "../src/domain/errors.js";

describe("setupConfig", () => {
  it("creates a private, valid starter config", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-setup-"));
    const path = join(root, "nested", "config.toml");

    const result = await setupConfig(path);
    const directoryStats = await lstat(join(root, "nested"));
    const stats = await lstat(path);
    const text = await readFile(path, "utf8");

    assert.equal(result, "created");
    assert.equal(directoryStats.mode & 0o777, 0o700);
    assert.equal(stats.mode & 0o777, 0o600);
    assert.deepEqual(parseConfigText(text), {
      version: 1,
      destinations: {},
      routes: [],
      privacy: {
        includePrompt: false,
        includeSummary: true,
        maxChars: 500,
      },
    });
    assert.equal(text, DEFAULT_CONFIG);
  });

  it("refuses to replace an existing config without force", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-setup-"));
    const path = join(root, "config.toml");
    await writeFile(path, "existing", { mode: 0o600 });

    await assert.rejects(setupConfig(path), (error: unknown) => {
      assert.ok(error instanceof HeraldError);
      assert.equal(error.code, "SETUP_EXISTS");
      return true;
    });
    assert.equal(await readFile(path, "utf8"), "existing");
  });

  it("replaces a regular file when force is explicit", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-setup-"));
    const path = join(root, "config.toml");
    await writeFile(path, "existing", { mode: 0o600 });

    const result = await setupConfig(path, { force: true });

    assert.equal(result, "replaced");
    assert.equal(await readFile(path, "utf8"), DEFAULT_CONFIG);
  });

  it("never follows an existing symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-setup-"));
    const target = join(root, "target.toml");
    const path = join(root, "config.toml");
    await writeFile(target, "target must remain unchanged", { mode: 0o600 });
    await symlink(target, path);

    await assert.rejects(setupConfig(path, { force: true }), (error: unknown) => {
      assert.ok(error instanceof HeraldError);
      assert.equal(error.code, "CONFIG_UNSAFE");
      return true;
    });
    assert.equal(await readFile(target, "utf8"), "target must remain unchanged");
  });
});
