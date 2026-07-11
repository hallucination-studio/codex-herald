import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeEvent } from "../src/core/router.js";
import type {
  DeliveryDependencies,
  HeraldConfig,
  LifecycleEvent,
  Notification,
} from "../src/domain/types.js";

const event: LifecycleEvent = {
  id: "evt-1",
  type: "turn.finished",
  source: "codex",
  sourceEvent: "Stop",
  project: "herald",
  occurredAt: "2026-07-11T00:00:00.000Z",
  summary: "Done",
};

const notification: Notification = {
  title: "Codex Herald",
  body: "Done",
  severity: "info",
  truncated: false,
};

describe("routeEvent", () => {
  it("returns no result when no route matches", async () => {
    const results = await routeEvent(
      configWithRoutes([]),
      event,
      notification,
      dependencies(),
    );

    assert.deepEqual(results, []);
  });

  it("deduplicates destinations selected by overlapping routes", async () => {
    let sends = 0;
    const results = await routeEvent(
      configWithRoutes([
        {
          events: ["turn.finished"],
          destinations: ["ops"],
          template: "compact",
        },
        {
          events: ["turn.finished"],
          destinations: ["ops"],
          template: "compact",
        },
      ]),
      event,
      notification,
      dependencies({
        sendWebhook: async () => {
          sends += 1;
          return { status: "accepted", code: "webhook_accepted" };
        },
      }),
    );

    assert.equal(sends, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.status, "accepted");
  });

  it("isolates a failing destination from a successful destination", async () => {
    const results = await routeEvent(
      configWithRoutes([
        {
          events: ["turn.finished"],
          destinations: ["ops", "phone"],
          template: "compact",
        },
      ]),
      event,
      notification,
      dependencies({
        sendWebhook: async () => {
          throw new Error("canary secret must not escape");
        },
        sendIMessage: async () => ({
          status: "accepted",
          code: "imsg_accepted",
        }),
      }),
    );

    assert.deepEqual(
      results.map(({ destination, status, code }) => ({
        destination,
        status,
        code,
      })),
      [
        {
          destination: "ops",
          status: "failed",
          code: "internal_error",
        },
        {
          destination: "phone",
          status: "accepted",
          code: "imsg_accepted",
        },
      ],
    );
    assert.equal(JSON.stringify(results).includes("canary"), false);
  });

  it("does not retain delivery history between invocations", async () => {
    let sends = 0;
    const deps = dependencies({
      sendWebhook: async () => {
        sends += 1;
        return { status: "failed", code: "webhook_network_error" };
      },
    });
    const config = configWithRoutes([
      {
        events: ["turn.finished"],
        destinations: ["ops"],
        template: "compact",
      },
    ]);

    const [first] = await routeEvent(config, event, notification, deps);
    const [repeated] = await routeEvent(config, event, notification, deps);

    assert.equal(sends, 2);
    assert.equal(first?.status, "failed");
    assert.equal(repeated?.status, "failed");
  });

  it("limits destination delivery concurrency to eight", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `ops-${index}`);
    const destinations = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          id,
          transport: "webhook" as const,
          url: { kind: "literal" as const, value: "https://example.com/hook" },
          headers: {},
          allowInsecureHttp: false,
          timeoutMs: 10_000,
        },
      ]),
    );
    const config: HeraldConfig = {
      ...configWithRoutes([]),
      destinations,
      routes: [
        {
          events: ["turn.finished"],
          destinations: ids,
          template: "compact",
        },
      ],
    };
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const routed = routeEvent(
      config,
      event,
      notification,
      dependencies({
        sendWebhook: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gate;
          active -= 1;
          return { status: "accepted", code: "webhook_accepted" };
        },
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      assert.equal(peak, 8);
    } finally {
      release?.();
    }
    assert.equal((await routed).length, 10);
  });
});

function configWithRoutes(routes: HeraldConfig["routes"]): HeraldConfig {
  return {
    version: 1,
    destinations: {
      ops: {
        id: "ops",
        transport: "webhook",
        url: { kind: "literal", value: "https://example.com/hook" },
        headers: {},
        allowInsecureHttp: false,
        timeoutMs: 10_000,
      },
      phone: {
        id: "phone",
        transport: "imessage",
        driver: "imsg",
        recipient: "+8613800000000",
        timeoutMs: 10_000,
      },
    },
    routes,
    privacy: {
      includePrompt: false,
      includeSummary: true,
      maxChars: 500,
    },
  };
}

function dependencies(
  overrides: Partial<DeliveryDependencies> = {},
): DeliveryDependencies {
  return {
    sendWebhook: async () => ({
      status: "accepted",
      code: "webhook_accepted",
    }),
    sendIMessage: async () => ({
      status: "accepted",
      code: "imsg_accepted",
    }),
    ...overrides,
  };
}
