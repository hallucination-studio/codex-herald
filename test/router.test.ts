import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ReceiptRepository, routeEvent } from "../src/core/router.js";
import type {
  DeliveryDependencies,
  DeliveryReceipt,
  HeraldConfig,
  LifecycleEvent,
  Notification,
} from "../src/domain/types.js";

const event: LifecycleEvent = {
  id: "evt-1",
  type: "turn.finished",
  source: "codex",
  sourceEvent: "Stop",
  occurredAt: "2026-07-11T00:00:00.000Z",
  summary: "Done",
};

const notification: Notification = {
  title: "Codex turn finished",
  body: "Done",
  severity: "info",
  truncated: false,
};

describe("routeEvent", () => {
  it("records a skipped receipt when no route matches", async () => {
    const store = new MemoryReceipts();

    const receipts = await routeEvent(
      configWithRoutes([]),
      event,
      notification,
      dependencies(),
      store,
    );

    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.status, "skipped");
    assert.equal(receipts[0]?.code, "no_matching_route");
    assert.equal(receipts[0]?.destination, null);
    assert.deepEqual(store.items, receipts);
  });

  it("deduplicates destinations selected by overlapping routes", async () => {
    let sends = 0;
    const store = new MemoryReceipts();
    const deps = dependencies({
      sendWebhook: async () => {
        sends += 1;
        return { status: "accepted", code: "webhook_accepted" };
      },
    });

    const receipts = await routeEvent(
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
      deps,
      store,
    );

    assert.equal(sends, 1);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.status, "accepted");
  });

  it("isolates a failing destination from a successful destination", async () => {
    const store = new MemoryReceipts();
    const config = configWithRoutes([
      {
        events: ["turn.finished"],
        destinations: ["ops", "phone"],
        template: "compact",
      },
    ]);
    const deps = dependencies({
      sendWebhook: async () => {
        throw new Error("canary secret must not escape");
      },
      sendIMessage: async () => ({
        status: "accepted",
        code: "imsg_accepted",
      }),
    });

    const receipts = await routeEvent(config, event, notification, deps, store);

    assert.deepEqual(
      receipts.map(({ destination, status, code }) => ({
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
    assert.equal(JSON.stringify(receipts).includes("canary"), false);
  });

  it("skips an event already accepted by the destination", async () => {
    let sends = 0;
    const store = new MemoryReceipts(new Set(["evt-1:ops"]));
    const deps = dependencies({
      sendWebhook: async () => {
        sends += 1;
        return { status: "accepted", code: "webhook_accepted" };
      },
    });

    const receipts = await routeEvent(
      configWithRoutes([
        {
          events: ["turn.finished"],
          destinations: ["ops"],
          template: "compact",
        },
      ]),
      event,
      notification,
      deps,
      store,
    );

    assert.equal(sends, 0);
    assert.equal(receipts[0]?.status, "skipped");
    assert.equal(receipts[0]?.code, "duplicate_event");
  });

  it("still delivers when the accepted receipt lookup is unavailable", async () => {
    let sends = 0;
    const items: DeliveryReceipt[] = [];
    const store: ReceiptRepository = {
      async hasAccepted() {
        throw new Error("receipt lookup unavailable");
      },
      async append(receipt) {
        items.push(receipt);
      },
    };

    const [receipt] = await routeEvent(
      configWithRoutes([
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
      store,
    );

    assert.equal(sends, 1);
    assert.equal(receipt?.status, "accepted");
    assert.deepEqual(items, [receipt]);
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
      new MemoryReceipts(),
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

class MemoryReceipts implements ReceiptRepository {
  readonly items: DeliveryReceipt[] = [];

  constructor(private readonly accepted = new Set<string>()) {}

  async hasAccepted(eventId: string, destination: string): Promise<boolean> {
    return this.accepted.has(`${eventId}:${destination}`);
  }

  async append(receipt: DeliveryReceipt): Promise<void> {
    this.items.push(receipt);
  }
}

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
    now: () => new Date("2026-07-11T00:00:01.000Z"),
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
