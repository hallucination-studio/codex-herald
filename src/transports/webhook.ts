import type {
  DeliveryOutcome,
  FailedCode,
  LifecycleEvent,
  Notification,
  ResolvableValue,
  SecretReference,
  WebhookDestination,
} from "../domain/types.js";

const BLOCKED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
  "user-agent",
  "x-codex-herald-event-id",
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DEADLINE_EXCEEDED = Symbol("webhook deadline exceeded");

export interface WebhookRuntime {
  resolveValue(value: ResolvableValue, signal?: AbortSignal): Promise<string>;
  resolveSecret(reference: SecretReference, signal?: AbortSignal): Promise<string>;
}

export type WebhookInspection =
  | { ok: true; code: "ready" }
  | { ok: false; code: FailedCode };

export async function sendWebhook(
  destination: WebhookDestination,
  event: LifecycleEvent,
  notification: Notification,
  runtime: WebhookRuntime,
): Promise<DeliveryOutcome> {
  const outcome = await completeBeforeDeadline(
    destination.timeoutMs,
    async (signal) => {
      const prepared = await prepareWebhook(destination, runtime, signal);
      if (!prepared.ok) {
        return { status: "failed", code: prepared.code } satisfies DeliveryOutcome;
      }

      return postJson(
        prepared.url,
        JSON.stringify({
          schema_version: 1,
          destination: destination.id,
          event: {
            id: event.id,
            type: event.type,
            source: event.source,
            source_event: event.sourceEvent,
            occurred_at: event.occurredAt,
          },
          notification: {
            title: notification.title,
            body: notification.body,
            severity: notification.severity,
            truncated: notification.truncated,
          },
        }),
        prepared.headers,
        event.id,
        signal,
      );
    },
  );

  return outcome === DEADLINE_EXCEEDED
    ? { status: "failed", code: "webhook_timeout" }
    : outcome;
}

export async function inspectWebhook(
  destination: WebhookDestination,
  runtime: WebhookRuntime,
): Promise<WebhookInspection> {
  const inspection = await completeBeforeDeadline(
    destination.timeoutMs,
    async (signal) => {
      const prepared = await prepareWebhook(destination, runtime, signal);
      return prepared.ok
        ? ({ ok: true, code: "ready" } as const)
        : ({ ok: false, code: prepared.code } as const);
    },
  );

  return inspection === DEADLINE_EXCEEDED
    ? { ok: false, code: "webhook_timeout" }
    : inspection;
}

type PreparedWebhook =
  | { ok: true; url: URL; headers: Readonly<Record<string, string>> }
  | { ok: false; code: FailedCode };

async function prepareWebhook(
  destination: WebhookDestination,
  runtime: WebhookRuntime,
  signal: AbortSignal,
): Promise<PreparedWebhook> {
  let rawUrl: string;
  try {
    signal.throwIfAborted();
    rawUrl = await runtime.resolveValue(destination.url, signal);
    signal.throwIfAborted();
  } catch {
    return failureCode(signal, "secret_unavailable");
  }

  const url = parseAllowedUrl(rawUrl, destination.allowInsecureHttp);
  if (!url) {
    return { ok: false, code: "webhook_unsafe_url" };
  }

  const headers = await resolveHeaders(destination, runtime, signal);
  return headers.ok ? { ok: true, url, headers: headers.value } : headers;
}

function parseAllowedUrl(rawUrl: string, allowInsecureHttp: boolean): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.username || url.password) {
    return null;
  }
  if (url.protocol === "https:") {
    return url;
  }
  return url.protocol === "http:" && allowInsecureHttp ? url : null;
}

async function resolveHeaders(
  destination: WebhookDestination,
  runtime: WebhookRuntime,
  signal: AbortSignal,
): Promise<
  | { ok: true; value: Readonly<Record<string, string>> }
  | { ok: false; code: FailedCode }
> {
  const headers: Record<string, string> = {};

  try {
    for (const [name, reference] of Object.entries(destination.headers)) {
      signal.throwIfAborted();
      if (!HEADER_NAME.test(name) || BLOCKED_HEADERS.has(name.toLowerCase())) {
        return { ok: false, code: "config_invalid" };
      }

      const value = await runtime.resolveSecret(reference, signal);
      signal.throwIfAborted();
      if (value.includes("\r") || value.includes("\n")) {
        return { ok: false, code: "config_invalid" };
      }
      headers[name] = value;
    }
  } catch {
    return failureCode(signal, "secret_unavailable");
  }

  return { ok: true, value: headers };
}

async function postJson(
  url: URL,
  body: string,
  customHeaders: Readonly<Record<string, string>>,
  eventId: string,
  signal: AbortSignal,
): Promise<DeliveryOutcome> {
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString(),
        "user-agent": "codex-herald/0.1.0",
        "x-codex-herald-event-id": eventId,
        ...customHeaders,
      },
      body,
    });
    try {
      await response.body?.cancel();
    } catch {
      // Status classification is complete; response content is intentionally ignored.
    }

    return response.status >= 200 && response.status < 300
      ? { status: "accepted", code: "webhook_accepted" }
      : { status: "failed", code: "webhook_http_error" };
  } catch {
    return {
      status: "failed",
      code: signal.aborted ? "webhook_timeout" : "webhook_network_error",
    };
  }
}

async function completeBeforeDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T | typeof DEADLINE_EXCEEDED> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(DEADLINE_EXCEEDED);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function failureCode(
  signal: AbortSignal,
  fallback: FailedCode,
): { ok: false; code: FailedCode } {
  return { ok: false, code: signal.aborted ? "webhook_timeout" : fallback };
}
