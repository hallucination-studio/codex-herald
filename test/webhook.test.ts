import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  LifecycleEvent,
  Notification,
  WebhookDestination,
} from "../src/domain/types.js";
import { sendWebhook } from "../src/transports/webhook.js";

const event: LifecycleEvent = {
  id: "evt-webhook",
  type: "turn.finished",
  source: "codex",
  sourceEvent: "Stop",
  occurredAt: "2026-07-11T00:00:00.000Z",
  summary: "Ready",
};

const notification: Notification = {
  title: "Codex turn finished",
  body: "Ready",
  severity: "info",
  truncated: false,
};

describe("sendWebhook", () => {
  it("rejects insecure HTTP without explicit opt-in", async () => {
    const outcome = await sendWebhook(
      destination("http://example.com/hook"),
      event,
      notification,
      runtime(),
    );

    assert.deepEqual(outcome, {
      status: "failed",
      code: "webhook_unsafe_url",
    });
  });

  it("rejects a hostname with any private DNS answer", async () => {
    const outcome = await sendWebhook(
      destination("https://mixed.example/hook"),
      event,
      notification,
      runtime({
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    );

    assert.deepEqual(outcome, {
      status: "failed",
      code: "webhook_unsafe_url",
    });
  });

  it("rejects public HTTP resolved from a secret even with both opt-ins", async () => {
    const outcome = await sendWebhook(
      {
        ...destination("ignored-secret-reference"),
        url: { kind: "env", name: "OPS_WEBHOOK_URL" },
        allowPrivateNetwork: true,
        allowInsecureHttp: true,
      },
      event,
      notification,
      runtime({
        resolveValue: async () => "http://public.example/hook",
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    );

    assert.deepEqual(outcome, {
      status: "failed",
      code: "webhook_unsafe_url",
    });
  });

  it("requires both HTTP opt-ins after a private URL is resolved from a secret", async () => {
    const outcome = await sendWebhook(
      {
        ...destination("ignored-secret-reference"),
        url: { kind: "env", name: "OPS_WEBHOOK_URL" },
        allowPrivateNetwork: false,
        allowInsecureHttp: true,
      },
      event,
      notification,
      runtime({
        resolveValue: async () => "http://private.example/hook",
        lookup: async () => [{ address: "10.0.0.5", family: 4 }],
      }),
    );

    assert.deepEqual(outcome, {
      status: "failed",
      code: "webhook_unsafe_url",
    });
  });

  it("posts the redacted notification to an explicitly allowed loopback target", async () => {
    let receivedBody = "";
    let receivedEventId: string | undefined;
    const server = createServer((request, response) => {
      receivedEventId = request.headers["x-codex-herald-event-id"] as
        | string
        | undefined;
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(202);
        response.end();
      });
    });

    await listen(server);
    const { port } = server.address() as AddressInfo;

    try {
      const outcome = await sendWebhook(
        {
          ...destination(`http://127.0.0.1:${port}/hook`),
          allowPrivateNetwork: true,
          allowInsecureHttp: true,
        },
        event,
        notification,
        runtime(),
      );

      assert.deepEqual(outcome, {
        status: "accepted",
        code: "webhook_accepted",
      });
      assert.equal(receivedEventId, event.id);
      assert.deepEqual(JSON.parse(receivedBody), {
        schema_version: 1,
        destination: "ops",
        event: {
          id: "evt-webhook",
          type: "turn.finished",
          source: "codex",
          source_event: "Stop",
          occurred_at: "2026-07-11T00:00:00.000Z",
        },
        notification: {
          title: "Codex turn finished",
          body: "Ready",
          severity: "info",
          truncated: false,
        },
      });
    } finally {
      await close(server);
    }
  });

  it("posts to a hostname using the DNS-pinned address", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });

    await listen(server);
    const { port } = server.address() as AddressInfo;

    try {
      const outcome = await sendWebhook(
        {
          ...destination(`http://webhook.test:${port}/hook`),
          allowPrivateNetwork: true,
          allowInsecureHttp: true,
        },
        event,
        notification,
        runtime({
          lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        }),
      );

      assert.deepEqual(outcome, {
        status: "accepted",
        code: "webhook_accepted",
      });
    } finally {
      await close(server);
    }
  });

  it("does not follow redirects", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: "http://127.0.0.1/private" });
      response.end();
    });

    await listen(server);
    const { port } = server.address() as AddressInfo;

    try {
      const outcome = await sendWebhook(
        {
          ...destination(`http://127.0.0.1:${port}/redirect`),
          allowPrivateNetwork: true,
          allowInsecureHttp: true,
        },
        event,
        notification,
        runtime(),
      );

      assert.deepEqual(outcome, {
        status: "failed",
        code: "webhook_http_error",
      });
    } finally {
      await close(server);
    }
  });

  it("bounds DNS resolution with the destination timeout", {
    timeout: 1_000,
  }, async () => {
    const startedAt = Date.now();

    const outcome = await sendWebhook(
      { ...destination("https://hanging.example/hook"), timeoutMs: 25 },
      event,
      notification,
      runtime({ lookup: () => new Promise(() => undefined) }),
    );

    assert.deepEqual(outcome, {
      status: "failed",
      code: "webhook_timeout",
    });
    assert.ok(Date.now() - startedAt < 500);
  });

  it("does not start another header lookup after preparation times out", async () => {
    let secretLookups = 0;
    const outcome = await sendWebhook(
      {
        ...destination("https://headers.example/hook"),
        timeoutMs: 25,
        headers: {
          "x-one": { kind: "env", name: "ONE" },
          "x-two": { kind: "env", name: "TWO" },
          "x-three": { kind: "env", name: "THREE" },
        },
      },
      event,
      notification,
      runtime({
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        resolveSecret: async () => {
          secretLookups += 1;
          await delay(50);
          return "resolved-secret";
        },
      }),
    );

    assert.deepEqual(outcome, {
      status: "failed",
      code: "webhook_timeout",
    });
    await delay(150);
    assert.equal(secretLookups, 1);
  });

  it("closes a successful response without waiting for its body", async () => {
    let markClosed: (() => void) | undefined;
    const responseClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.once("close", () => markClosed?.());
      response.writeHead(200);
      response.write("streaming forever");
    });

    await listen(server);
    const { port } = server.address() as AddressInfo;

    try {
      const outcome = await sendWebhook(
        {
          ...destination(`http://127.0.0.1:${port}/stream`),
          allowPrivateNetwork: true,
          allowInsecureHttp: true,
        },
        event,
        notification,
        runtime(),
      );

      assert.deepEqual(outcome, {
        status: "accepted",
        code: "webhook_accepted",
      });
      await Promise.race([
        responseClosed,
        delay(500).then(() => {
          throw new Error("successful webhook response remained open");
        }),
      ]);
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});

function destination(url: string): WebhookDestination {
  return {
    id: "ops",
    transport: "webhook",
    url: { kind: "literal", value: url },
    headers: {},
    allowPrivateNetwork: false,
    allowInsecureHttp: false,
    timeoutMs: 1_000,
  };
}

function runtime(
  overrides: Partial<Parameters<typeof sendWebhook>[3]> = {},
): Parameters<typeof sendWebhook>[3] {
  return {
    resolveValue: async (value) =>
      value.kind === "literal" ? value.value : "resolved-secret",
    resolveSecret: async () => "resolved-secret",
    ...overrides,
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
