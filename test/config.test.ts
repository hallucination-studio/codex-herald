import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, parseConfigText, resolveConfigPath } from "../src/config/index.js";
import { HeraldError } from "../src/domain/errors.js";

describe("parseConfigText", () => {
  it("parses destinations, routes, privacy defaults, and secret references", () => {
    const config = parseConfigText(`
version = 1

[destinations.phone]
transport = "imessage"
driver = "imsg"
recipient = "+8613800000000"

[destinations.ops]
transport = "webhook"
url = "$OPS_WEBHOOK_URL"

[destinations.audit]
transport = "webhook"
url = "keychain://codex-herald/audit-webhook"

[destinations.audit.headers]
Authorization = "keychain://codex-herald/audit-token"
X-Trace = "$TRACE_TOKEN"

[[routes]]
events = ["turn.finished"]
destinations = ["phone", "ops", "audit"]
template = "compact"

[privacy]
include_prompt = false
`);

    assert.deepEqual(config, {
      version: 1,
      destinations: {
        phone: {
          id: "phone",
          transport: "imessage",
          driver: "imsg",
          recipient: "+8613800000000",
          timeoutMs: 10_000,
        },
        ops: {
          id: "ops",
          transport: "webhook",
          url: { kind: "env", name: "OPS_WEBHOOK_URL" },
          headers: {},
          allowInsecureHttp: false,
          timeoutMs: 10_000,
        },
        audit: {
          id: "audit",
          transport: "webhook",
          url: {
            kind: "keychain",
            service: "codex-herald",
            account: "audit-webhook",
          },
          headers: {
            Authorization: {
              kind: "keychain",
              service: "codex-herald",
              account: "audit-token",
            },
            "X-Trace": { kind: "env", name: "TRACE_TOKEN" },
          },
          allowInsecureHttp: false,
          timeoutMs: 10_000,
        },
      },
      routes: [
        {
          events: ["turn.finished"],
          destinations: ["phone", "ops", "audit"],
          template: "compact",
        },
      ],
      privacy: {
        includePrompt: false,
        includeSummary: true,
        maxChars: 500,
      },
    });
  });

  it("parses a literal HTTPS webhook without resolving environment values", () => {
    const previous = process.env.OPS_WEBHOOK_URL;
    process.env.OPS_WEBHOOK_URL = "https://should-not-be-read.example";
    try {
      const config = parseConfigText(
        validConfig({ webhookUrl: "https://example.com/hook" }),
      );

      const destination = config.destinations.ops;
      assert.equal(destination?.transport, "webhook");
      if (destination?.transport === "webhook") {
        assert.deepEqual(destination.url, {
          kind: "literal",
          value: "https://example.com/hook",
        });
      }
    } finally {
      if (previous === undefined) {
        delete process.env.OPS_WEBHOOK_URL;
      } else {
        process.env.OPS_WEBHOOK_URL = previous;
      }
    }
  });

  it("rejects unknown keys at every fixed schema level", () => {
    const invalidConfigs = [
      validConfig({ extraTopLevel: "surprise = true" }),
      validConfig({ extraDestination: 'recpient = "+8613800000000"' }),
      validConfig({ extraRoute: 'templat = "compact"' }),
      validConfig({ extraPrivacy: "include_promt = false" }),
    ];

    for (const text of invalidConfigs) {
      assertConfigError(() => parseConfigText(text));
    }
  });

  it("rejects unresolved route destinations and invalid destination identifiers", () => {
    assertConfigError(() =>
      parseConfigText(validConfig({ routeDestinations: '"missing"' })),
    );
    assertConfigError(() =>
      parseConfigText(validConfig({ routeDestinations: '"constructor"' })),
    );
    assertConfigError(() =>
      parseConfigText(validConfig({ destinationName: '"bad id"' })),
    );
  });

  it("enforces destination and route collection limits", () => {
    const destinations = Array.from(
      { length: 33 },
      (_, index) => `
[destinations.d${index}]
transport = "webhook"
url = "https://example.com/${index}"
`,
    ).join("");
    assertConfigError(() =>
      parseConfigText(`
version = 1
${destinations}
[[routes]]
events = ["turn.finished"]
destinations = ["d0"]
template = "compact"
[privacy]
include_prompt = false
`),
    );

    const routes = Array.from(
      { length: 65 },
      () => `
[[routes]]
events = ["turn.finished"]
destinations = ["ops"]
template = "compact"
`,
    ).join("");
    assertConfigError(() =>
      parseConfigText(`
version = 1
[destinations.ops]
transport = "webhook"
url = "https://example.com/hook"
${routes}
[privacy]
include_prompt = false
`),
    );
  });

  it("enforces per-route event and destination limits", () => {
    const tooManyEvents = Array.from({ length: 17 }, () => '"turn.finished"').join(
      ", ",
    );
    assertConfigError(() =>
      parseConfigText(validConfig({ routeEvents: tooManyEvents })),
    );

    const destinations = Array.from(
      { length: 33 },
      (_, index) => `
[destinations.d${index}]
transport = "webhook"
url = "https://example.com/${index}"
`,
    ).join("");
    const routeDestinations = Array.from(
      { length: 33 },
      (_, index) => `"d${index}"`,
    ).join(", ");
    assertConfigError(() =>
      parseConfigText(`
version = 1
${destinations}
[[routes]]
events = ["turn.finished"]
destinations = [${routeDestinations}]
template = "compact"
[privacy]
include_prompt = false
`),
    );
  });

  it("rejects unsupported versions, events, templates, and privacy values", () => {
    const invalidConfigs = [
      validConfig({ version: 2 }),
      validConfig({ routeEvents: '"session.finished"' }),
      validConfig({ routeTemplate: "verbose" }),
      validConfig({ includePrompt: true }),
      validConfig({ maxChars: 0 }),
      validConfig({ maxChars: 4001 }),
    ];

    for (const text of invalidConfigs) {
      assertConfigError(() => parseConfigText(text));
    }
  });

  it("accepts HTTP webhooks only with the explicit insecure opt-in", () => {
    assertConfigError(() =>
      parseConfigText(validConfig({ webhookUrl: "http://127.0.0.1/hook" })),
    );

    const config = parseConfigText(
      validConfig({
        webhookUrl: "http://127.0.0.1/hook",
        webhookFlags: "allow_insecure_http = true",
      }),
    );
    const destination = config.destinations.ops;
    assert.equal(destination?.transport, "webhook");
    if (destination?.transport === "webhook") {
      assert.equal(destination.allowInsecureHttp, true);
    }

    const secretUrl = parseConfigText(
      validConfig({
        webhookUrl: "$OPS_WEBHOOK_URL",
        webhookFlags: "allow_insecure_http = true",
      }),
    );
    assert.equal(
      secretUrl.destinations.ops?.transport === "webhook" &&
        secretUrl.destinations.ops.allowInsecureHttp,
      true,
    );

    assertConfigError(() =>
      parseConfigText(validConfig({ webhookFlags: "allow_private_network = true" })),
    );
  });

  it("rejects URL userinfo and literal webhook header values", () => {
    assertConfigError(() =>
      parseConfigText(
        validConfig({ webhookUrl: "https://user:pass@example.com/hook" }),
      ),
    );
    assertConfigError(() =>
      parseConfigText(
        `${validConfig()}\n[destinations.ops.headers]\nAuthorization = "Bearer secret"\n`,
      ),
    );
  });

  it("limits the number of webhook secret headers", () => {
    const headers = Array.from(
      { length: 17 },
      (_, index) => `X-Header-${index} = "$TOKEN_${index}"`,
    ).join("\n");

    assertConfigError(() =>
      parseConfigText(`${validConfig()}\n[destinations.ops.headers]\n${headers}\n`),
    );
  });

  it("requires environment references to use an all-uppercase name", () => {
    assertConfigError(() =>
      parseConfigText(
        `${validConfig()}\n[destinations.ops.headers]\nAuthorization = "$lowercase"
`,
      ),
    );
  });

  it("rejects prototype-mutating table keys", () => {
    assertConfigError(() =>
      parseConfigText(
        `${validConfig()}\n[destinations.ops.headers]\n"__proto__" = "$HEADER_TOKEN"
`,
      ),
    );
  });
});

describe("resolveConfigPath", () => {
  it("uses explicit, environment, XDG, then home paths in order", () => {
    assert.equal(
      resolveConfigPath({
        explicitPath: "/explicit/config.toml",
        env: {
          CODEX_HERALD_CONFIG: "/env/config.toml",
          XDG_CONFIG_HOME: "/xdg",
          HOME: "/home/user",
        },
      }),
      "/explicit/config.toml",
    );
    assert.equal(
      resolveConfigPath({
        env: {
          CODEX_HERALD_CONFIG: "/env/config.toml",
          XDG_CONFIG_HOME: "/xdg",
          HOME: "/home/user",
        },
      }),
      "/env/config.toml",
    );
    assert.equal(
      resolveConfigPath({
        env: { XDG_CONFIG_HOME: "/xdg", HOME: "/home/user" },
      }),
      "/xdg/codex-herald/config.toml",
    );
    assert.equal(
      resolveConfigPath({
        env: { HOME: "/ignored/home", PLUGIN_DATA: "/repo/plugin-data" },
        homeDir: "/trusted/home",
      }),
      "/trusted/home/.config/codex-herald/config.toml",
    );
  });

  it("does not use cwd or PLUGIN_DATA as an implicit config source", () => {
    const path = resolveConfigPath({
      env: {
        HOME: "/users/alice",
        PLUGIN_DATA: "/untrusted/repository/plugin-data",
      },
    });

    assert.equal(path, "/users/alice/.config/codex-herald/config.toml");
    assert.equal(path.includes("plugin-data"), false);
    assert.equal(path.startsWith(process.cwd()), false);
  });

  it("rejects relative home paths instead of resolving them through cwd", () => {
    assertConfigError(() => resolveConfigPath({ env: { HOME: "." } }));
    assertConfigError(() => resolveConfigPath({ env: {}, homeDir: "relative/home" }));
  });

  it("rejects a relative environment override instead of resolving it through cwd", () => {
    assertConfigError(() =>
      resolveConfigPath({ env: { CODEX_HERALD_CONFIG: "config.toml" } }),
    );
  });
});

describe("loadConfig", () => {
  it("loads a regular owner-only file and returns its resolved path", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "config.toml");
      await writeFile(path, validConfig(), { mode: 0o600 });

      const loaded = await loadConfig({ explicitPath: path, env: {} });

      assert.equal(loaded.path, path);
      assert.equal(loaded.config.version, 1);
      assert.equal(loaded.config.privacy.maxChars, 500);
    });
  });

  it("rejects symbolic links even when their target is safe", async () => {
    await withTempDirectory(async (directory) => {
      const target = join(directory, "target.toml");
      const link = join(directory, "config.toml");
      await writeFile(target, validConfig(), { mode: 0o600 });
      await symlink(target, link);

      await assertConfigLoadError(
        () => loadConfig({ explicitPath: link, env: {} }),
        "CONFIG_UNSAFE",
      );
    });
  });

  it("rejects files readable or writable by the group or other users", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "config.toml");
      await writeFile(path, validConfig(), { mode: 0o600 });

      for (const mode of [0o644, 0o640, 0o620, 0o602]) {
        await chmod(path, mode);
        await assertConfigLoadError(
          () => loadConfig({ explicitPath: path, env: {} }),
          "CONFIG_UNSAFE",
        );
      }
    });
  });

  it("rejects config files larger than one MiB", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "config.toml");
      await writeFile(path, validConfig(), { mode: 0o600 });
      await truncate(path, 1024 * 1024 + 1);

      await assertConfigLoadError(
        () => loadConfig({ explicitPath: path, env: {} }),
        "CONFIG_UNSAFE",
      );
    });
  });

  it("bounds the read when a file grows after its metadata check", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "config.toml");
      await writeFile(path, validConfig(), { mode: 0o600 });

      const probe = await open(path, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        stat: () => Promise<Stats>;
      };
      const originalStat = prototype.stat;
      await probe.close();

      let grew = false;
      prototype.stat = async function statAfterGrowth() {
        const stats = (await Reflect.apply(originalStat, this, [])) as Stats;
        if (!grew) {
          grew = true;
          await truncate(path, 1024 * 1024 + 1);
        }
        return stats;
      };

      try {
        await assertConfigLoadError(
          () => loadConfig({ explicitPath: path, env: {} }),
          "CONFIG_UNSAFE",
        );
      } finally {
        prototype.stat = originalStat;
      }
    });
  });

  it("rejects a file owned by another uid when the platform exposes uid", async (t) => {
    if (process.getuid === undefined || process.getuid() === 0) {
      t.skip("requires a non-root POSIX user");
      return;
    }

    const path = "/etc/hosts";
    const stats = await lstat(path);
    if (stats.uid === process.getuid()) {
      t.skip("system fixture is owned by the current user");
      return;
    }

    await assertConfigLoadError(
      () => loadConfig({ explicitPath: path, env: {} }),
      "CONFIG_UNSAFE",
    );
  });

  it("reports a missing selected config without checking the repository", async () => {
    await withTempDirectory(async (directory) => {
      const selected = join(
        directory,
        "home",
        ".config",
        "codex-herald",
        "config.toml",
      );
      await mkdir(join(directory, "repository"), { recursive: true });
      await writeFile(join(directory, "repository", "config.toml"), validConfig(), {
        mode: 0o600,
      });

      await assertConfigLoadError(
        () => loadConfig({ env: {}, homeDir: join(directory, "home") }),
        "CONFIG_NOT_FOUND",
      );
      assert.equal(
        resolveConfigPath({ env: {}, homeDir: join(directory, "home") }),
        selected,
      );
    });
  });
});

interface ValidConfigOptions {
  destinationName?: string;
  extraDestination?: string;
  extraPrivacy?: string;
  extraRoute?: string;
  extraTopLevel?: string;
  includePrompt?: boolean;
  maxChars?: number;
  routeDestinations?: string;
  routeEvents?: string;
  routeTemplate?: string;
  version?: number;
  webhookFlags?: string;
  webhookUrl?: string;
}

function validConfig(options: ValidConfigOptions = {}): string {
  return `
version = ${options.version ?? 1}
${options.extraTopLevel ?? ""}

[destinations.${options.destinationName ?? "ops"}]
transport = "webhook"
url = "${options.webhookUrl ?? "$OPS_WEBHOOK_URL"}"
${options.webhookFlags ?? ""}

[destinations.phone]
transport = "imessage"
driver = "imsg"
recipient = "+8613800000000"
${options.extraDestination ?? ""}

[[routes]]
events = [${options.routeEvents ?? '"turn.finished"'}]
destinations = [${options.routeDestinations ?? '"ops", "phone"'}]
template = "${options.routeTemplate ?? "compact"}"
${options.extraRoute ?? ""}

[privacy]
include_prompt = ${options.includePrompt ?? false}
include_summary = true
max_chars = ${options.maxChars ?? 500}
${options.extraPrivacy ?? ""}
`;
}

function assertConfigError(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HeraldError);
    assert.equal(error.code, "CONFIG_INVALID");
    return true;
  });
}

async function assertConfigLoadError(
  run: () => Promise<unknown>,
  code: HeraldError["code"],
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof HeraldError);
    assert.equal(error.code, code);
    return true;
  });
}

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codex-herald-config-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
