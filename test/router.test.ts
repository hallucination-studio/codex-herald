import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type ReceiptRepository, routeEvent } from "../src/core/router.js";
import type {
  DeliveryDependencies,
  DeliveryReceipt,
  HeraldConfig,
  LifecycleEvent,
  Notification,
} from "../src/domain/types.js";
import { acceptedKey, createReceiptRepository } from "../src/observability/receipts.js";

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

  it("serializes the same delivery across independent receipt repositories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-herald-route-lock-"));
    const receiptPath = join(directory, "receipts.ndjson");
    let sends = 0;
    const deps = dependencies({
      sendWebhook: async () => {
        sends += 1;
        await delay(50);
        return { status: "accepted", code: "webhook_accepted" };
      },
    });
    const config = configWithRoutes([
      {
        events: ["turn.finished"],
        destinations: ["ops"],
        template: "compact",
      },
    ]);

    try {
      const routed = await Promise.all([
        routeEvent(
          config,
          event,
          notification,
          deps,
          createReceiptRepository(receiptPath),
        ),
        routeEvent(
          config,
          event,
          notification,
          deps,
          createReceiptRepository(receiptPath),
        ),
      ]);

      assert.equal(sends, 1);
      assert.deepEqual(
        routed
          .flat()
          .map(({ status, code }) => ({ status, code }))
          .sort((left, right) => left.status.localeCompare(right.status)),
        [
          { status: "accepted", code: "webhook_accepted" },
          { status: "skipped", code: "duplicate_event" },
        ],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a delivery lock left by a dead process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-herald-dead-lock-"));
    const receiptPath = join(directory, "receipts.ndjson");
    const digest = createHash("sha256")
      .update(acceptedKey(event.id, "ops"))
      .digest("hex");
    const lockPath = `${receiptPath}.${digest}.delivery.lock`;
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, "owner.2147483647.dead"), "2147483647\n", {
      mode: 0o600,
    });
    await utimes(lockPath, new Date(0), new Date(0));

    try {
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
        dependencies(),
        createReceiptRepository(receiptPath),
      );

      assert.equal(receipt?.status, "accepted");
      assert.equal(receipt?.code, "webhook_accepted");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes the same delivery across operating-system processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-herald-process-lock-"));
    const receiptPath = join(directory, "receipts.ndjson");
    const sendsPath = join(directory, "sends.txt");

    try {
      const outcomes = await Promise.all([
        runRouteWorker(receiptPath, sendsPath),
        runRouteWorker(receiptPath, sendsPath),
      ]);

      assert.equal(await readSendCount(sendsPath), 1);
      assert.deepEqual(
        outcomes.sort((left, right) => left.status.localeCompare(right.status)),
        [
          { status: "accepted", code: "webhook_accepted" },
          { status: "skipped", code: "duplicate_event" },
        ],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

interface WorkerOutcome {
  status: "accepted" | "skipped";
  code: "webhook_accepted" | "duplicate_event";
}

function runRouteWorker(
  receiptPath: string,
  sendsPath: string,
): Promise<WorkerOutcome> {
  const routerUrl = new URL("../src/core/router.js", import.meta.url).href;
  const receiptsUrl = new URL("../src/observability/receipts.js", import.meta.url).href;
  const source = `
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { routeEvent } from ${JSON.stringify(routerUrl)};
import { createReceiptRepository } from ${JSON.stringify(receiptsUrl)};

const event = ${JSON.stringify(event)};
const config = ${JSON.stringify(
    configWithRoutes([
      {
        events: ["turn.finished"],
        destinations: ["ops"],
        template: "compact",
      },
    ]),
  )};
const notification = ${JSON.stringify(notification)};
const [receipt] = await routeEvent(config, event, notification, {
  now: () => new Date("2026-07-11T00:00:01.000Z"),
  sendWebhook: async () => {
    await appendFile(${JSON.stringify(sendsPath)}, "sent\\n");
    await delay(250);
    return { status: "accepted", code: "webhook_accepted" };
  },
  sendIMessage: async () => ({ status: "accepted", code: "imsg_accepted" }),
}, createReceiptRepository(${JSON.stringify(receiptPath)}));
process.stdout.write(JSON.stringify({ status: receipt.status, code: receipt.code }));
`;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`route worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as WorkerOutcome);
    });
  });
}

async function readSendCount(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).length;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return 0;
    }
    throw error;
  }
}

class MemoryReceipts implements ReceiptRepository {
  readonly items: DeliveryReceipt[] = [];

  constructor(private readonly accepted = new Set<string>()) {}

  async hasAccepted(eventId: string, destination: string): Promise<boolean> {
    return this.accepted.has(`${eventId}:${destination}`);
  }

  async append(receipt: DeliveryReceipt): Promise<void> {
    this.items.push(receipt);
  }

  async withDeliveryLock<T>(
    eventId: string,
    destination: string,
    action: (alreadyAccepted: boolean) => Promise<T>,
  ): Promise<T> {
    return action(await this.hasAccepted(eventId, destination));
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
        allowPrivateNetwork: false,
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
