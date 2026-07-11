import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  type RequestOptions as HttpRequestOptions,
  request as httpRequest,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import ipaddr from "ipaddr.js";
import type {
  DeliveryOutcome,
  FailedCode,
  LifecycleEvent,
  Notification,
  ResolvableValue,
  SecretReference,
  WebhookDestination,
} from "../domain/types.js";

const PRIVATE_RANGES = new Set([
  "private",
  "loopback",
  "linkLocal",
  "uniqueLocal",
  "carrierGradeNat",
]);
const BLOCKED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
  "user-agent",
  "x-codex-herald-event-id",
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PREPARATION_TIMEOUT = Symbol("webhook preparation timeout");

export interface WebhookRuntime {
  resolveValue(value: ResolvableValue, signal?: AbortSignal): Promise<string>;
  resolveSecret(reference: SecretReference, signal?: AbortSignal): Promise<string>;
  lookup?(hostname: string, signal?: AbortSignal): Promise<readonly LookupAddress[]>;
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
  const deadline = performance.now() + destination.timeoutMs;
  const preparation = new AbortController();
  const prepared = await completeBeforeDeadline(
    prepareWebhook(destination, runtime, preparation.signal),
    deadline,
    () => preparation.abort(),
  );
  if (prepared === PREPARATION_TIMEOUT) {
    return { status: "failed", code: "webhook_timeout" };
  }
  if (!prepared.ok) {
    return { status: "failed", code: prepared.code };
  }

  const body = JSON.stringify({
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
  });

  return postJson(
    prepared.url,
    prepared.address,
    body,
    prepared.headers,
    event.id,
    Math.max(1, Math.ceil(deadline - performance.now())),
  );
}

export async function inspectWebhook(
  destination: WebhookDestination,
  runtime: WebhookRuntime,
): Promise<WebhookInspection> {
  const preparation = new AbortController();
  const prepared = await completeBeforeDeadline(
    prepareWebhook(destination, runtime, preparation.signal),
    performance.now() + destination.timeoutMs,
    () => preparation.abort(),
  );
  if (prepared === PREPARATION_TIMEOUT) {
    return { ok: false, code: "webhook_timeout" };
  }
  return prepared.ok ? { ok: true, code: "ready" } : { ok: false, code: prepared.code };
}

function completeBeforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  onTimeout: () => void,
): Promise<T | typeof PREPARATION_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      onTimeout();
      resolve(PREPARATION_TIMEOUT);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        onTimeout();
        resolve(PREPARATION_TIMEOUT);
      }
    }, Math.ceil(remainingMs));

    operation.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
}

type PreparedWebhook =
  | {
      ok: true;
      url: URL;
      address: LookupAddress;
      headers: Readonly<Record<string, string>>;
    }
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
    return { ok: false, code: "secret_unavailable" };
  }

  const url = parseAllowedUrl(rawUrl, destination);
  if (!url) {
    return { ok: false, code: "webhook_unsafe_url" };
  }

  let addresses: readonly LookupAddress[];
  try {
    addresses = await resolveAddresses(url.hostname, runtime.lookup, signal);
  } catch {
    return { ok: false, code: "webhook_network_error" };
  }

  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address }) =>
        !isAllowedAddress(address, url.protocol, destination.allowPrivateNetwork),
    )
  ) {
    return { ok: false, code: "webhook_unsafe_url" };
  }

  const selectedAddress = addresses[0];
  if (!selectedAddress) {
    return { ok: false, code: "webhook_network_error" };
  }

  const headerResult = await resolveHeaders(destination, runtime, signal);
  if (!headerResult.ok) {
    return headerResult;
  }

  return {
    ok: true,
    url,
    address: selectedAddress,
    headers: headerResult.headers,
  };
}

function parseAllowedUrl(rawUrl: string, destination: WebhookDestination): URL | null {
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

  if (
    url.protocol === "http:" &&
    destination.allowPrivateNetwork &&
    destination.allowInsecureHttp
  ) {
    return url;
  }

  return null;
}

async function resolveAddresses(
  rawHostname: string,
  lookupOverride?: WebhookRuntime["lookup"],
  signal?: AbortSignal,
): Promise<readonly LookupAddress[]> {
  signal?.throwIfAborted();
  const hostname = stripIpv6Brackets(rawHostname);
  const family = isIP(hostname);
  if (family === 4 || family === 6) {
    return [{ address: hostname, family }];
  }

  if (lookupOverride) {
    const addresses = await lookupOverride(hostname, signal);
    signal?.throwIfAborted();
    return addresses;
  }

  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  signal?.throwIfAborted();
  return addresses;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isAllowedAddress(
  address: string,
  protocol: string,
  allowPrivateNetwork: boolean,
): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.process(address);
  } catch {
    return false;
  }

  const range = parsed.range();
  if (protocol === "http:") {
    return allowPrivateNetwork && PRIVATE_RANGES.has(range);
  }
  return range === "unicast" || (allowPrivateNetwork && PRIVATE_RANGES.has(range));
}

async function resolveHeaders(
  destination: WebhookDestination,
  runtime: WebhookRuntime,
  signal: AbortSignal,
): Promise<
  { ok: true; headers: Record<string, string> } | { ok: false; code: FailedCode }
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
    return { ok: false, code: "secret_unavailable" };
  }

  return { ok: true, headers };
}

function postJson(
  url: URL,
  address: LookupAddress,
  body: string,
  customHeaders: Readonly<Record<string, string>>,
  eventId: string,
  timeoutMs: number,
): Promise<DeliveryOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: DeliveryOutcome) => {
      if (!settled) {
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve(outcome);
      }
    };

    const options: HttpRequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString(),
        "user-agent": "codex-herald/0.1.0",
        "x-codex-herald-event-id": eventId,
        ...customHeaders,
      },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          callback(null, [address]);
        } else {
          callback(null, address.address, address.family);
        }
      },
    };

    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    let outgoing: ReturnType<typeof request>;
    try {
      outgoing = request(options, (response) => {
        const statusCode = response.statusCode ?? 0;
        finish(
          statusCode >= 200 && statusCode < 300
            ? { status: "accepted", code: "webhook_accepted" }
            : { status: "failed", code: "webhook_http_error" },
        );
        response.destroy();
      });
    } catch {
      finish({ status: "failed", code: "webhook_network_error" });
      return;
    }

    outgoing.once("error", () => {
      finish({
        status: "failed",
        code: timedOut ? "webhook_timeout" : "webhook_network_error",
      });
    });
    outgoing.end(body);

    timer = setTimeout(() => {
      timedOut = true;
      outgoing.destroy(new Error("webhook timeout"));
    }, timeoutMs);
    timer.unref();
  });
}
