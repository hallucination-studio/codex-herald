import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveSecret,
  resolveValue,
  type SecretDependencies,
} from "../src/config/secrets.js";
import { HeraldError } from "../src/domain/errors.js";

describe("secret resolution", () => {
  it("resolves an exact environment reference", async () => {
    const value = await resolveSecret(
      { kind: "env", name: "OPS_WEBHOOK_URL" },
      dependencies({ env: { OPS_WEBHOOK_URL: "https://example.com/secret" } }),
    );

    assert.equal(value, "https://example.com/secret");
  });

  it("fails closed when an environment reference is missing", async () => {
    await assert.rejects(
      resolveSecret({ kind: "env", name: "MISSING_SECRET" }, dependencies({ env: {} })),
      (error: unknown) => {
        assert.ok(error instanceof HeraldError);
        assert.equal(error.code, "SECRET_UNAVAILABLE");
        assert.doesNotMatch(error.message, /undefined|null/u);
        return true;
      },
    );
  });

  it("resolves a Keychain reference only on macOS", async () => {
    const calls: Array<[string, string]> = [];
    const value = await resolveSecret(
      { kind: "keychain", service: "codex-herald", account: "ops" },
      dependencies({
        platform: "darwin",
        readKeychain: async (service, account) => {
          calls.push([service, account]);
          return "keychain-secret\n";
        },
      }),
    );

    assert.equal(value, "keychain-secret");
    assert.deepEqual(calls, [["codex-herald", "ops"]]);
  });

  it("does not attempt Keychain access on another platform", async () => {
    let called = false;

    await assert.rejects(
      resolveSecret(
        { kind: "keychain", service: "codex-herald", account: "ops" },
        dependencies({
          platform: "linux",
          readKeychain: async () => {
            called = true;
            return "must-not-run";
          },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof HeraldError);
        assert.equal(error.code, "SECRET_UNAVAILABLE");
        return true;
      },
    );
    assert.equal(called, false);
  });

  it("returns literal values without consulting secret providers", async () => {
    const value = await resolveValue(
      { kind: "literal", value: "https://example.com/public-hook" },
      dependencies({
        env: { SHOULD_NOT_BE_USED: "canary" },
        readKeychain: async () => {
          throw new Error("must not run");
        },
      }),
    );

    assert.equal(value, "https://example.com/public-hook");
  });
});

function dependencies(overrides: Partial<SecretDependencies> = {}): SecretDependencies {
  return {
    env: {},
    platform: "darwin",
    readKeychain: async () => "default-secret",
    ...overrides,
  };
}
