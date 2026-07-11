import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseConfigText } from "../src/config/index.js";
import { DEFAULT_CONFIG, setupConfig } from "../src/config/setup.js";
import { HeraldError } from "../src/domain/errors.js";

describe("setupConfig", () => {
  it("atomically creates a private, valid starter config", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-setup-"));
    const path = join(root, "nested", "config.toml");

    const result = await setupConfig(path);
    const stats = await lstat(path);
    const text = await readFile(path, "utf8");

    assert.equal(result, "created");
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

  it("allows only one concurrent non-force setup to create the config", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-herald-setup-"));
    const path = join(root, "config.toml");

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => setupConfig(path)),
    );

    const created = results.filter(
      (result): result is PromiseFulfilledResult<"created" | "replaced"> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.deepEqual(
      created.map(({ value }) => value),
      ["created"],
    );
    assert.equal(rejected.length, 7);
    for (const result of rejected) {
      assert.ok(result.reason instanceof HeraldError);
      assert.equal(result.reason.code, "SETUP_EXISTS");
    }
    assert.equal(await readFile(path, "utf8"), DEFAULT_CONFIG);
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
