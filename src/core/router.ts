import { performance } from "node:perf_hooks";
import type {
  DeliveryDependencies,
  DeliveryOutcome,
  DeliveryReceipt,
  Destination,
  Driver,
  HeraldConfig,
  LifecycleEvent,
  Notification,
} from "../domain/types.js";

const DEFAULT_CONCURRENCY = 8;

export interface ReceiptRepository {
  hasAttempted(eventId: string, destination: string): Promise<boolean>;
  append(receipt: DeliveryReceipt): Promise<void>;
}

export async function routeEvent(
  config: HeraldConfig,
  event: LifecycleEvent,
  notification: Notification,
  dependencies: DeliveryDependencies,
  receipts: ReceiptRepository,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<DeliveryReceipt[]> {
  const destinationIds = matchingDestinations(config, event);

  if (destinationIds.length === 0) {
    const receipt = createReceipt(
      event,
      null,
      { status: "skipped", code: "no_matching_route" },
      dependencies,
      0,
    );
    await receipts.append(receipt);
    return [receipt];
  }

  return mapWithConcurrency(destinationIds, concurrency, async (destinationId) => {
    const destination = config.destinations[destinationId];
    if (!destination) {
      const receipt = createReceipt(
        event,
        null,
        { status: "failed", code: "config_invalid" },
        dependencies,
        0,
      );
      await receipts.append(receipt);
      return receipt;
    }

    const attempt = await lookupAttempt(receipts, event.id, destinationId);
    if (attempt === "unavailable") {
      const receipt = createReceipt(
        event,
        destination,
        { status: "failed", code: "internal_error" },
        dependencies,
        0,
      );
      await receipts.append(receipt);
      return receipt;
    }
    if (attempt === "attempted") {
      const receipt = createReceipt(
        event,
        destination,
        { status: "skipped", code: "duplicate_event" },
        dependencies,
        0,
      );
      await receipts.append(receipt);
      return receipt;
    }

    const startedAt = performance.now();
    let outcome: DeliveryOutcome;
    try {
      outcome = await send(destination, event, notification, dependencies);
    } catch {
      outcome = { status: "failed", code: "internal_error" };
    }

    const receipt = createReceipt(
      event,
      destination,
      outcome,
      dependencies,
      performance.now() - startedAt,
    );
    await receipts.append(receipt);
    return receipt;
  });
}

async function lookupAttempt(
  receipts: ReceiptRepository,
  eventId: string,
  destination: string,
): Promise<"attempted" | "not_attempted" | "unavailable"> {
  try {
    return (await receipts.hasAttempted(eventId, destination))
      ? "attempted"
      : "not_attempted";
  } catch {
    return "unavailable";
  }
}

function matchingDestinations(config: HeraldConfig, event: LifecycleEvent): string[] {
  const destinationIds = new Set<string>();

  for (const route of config.routes) {
    if (!route.events.includes(event.type)) {
      continue;
    }

    for (const destination of route.destinations) {
      destinationIds.add(destination);
    }
  }

  return [...destinationIds];
}

function send(
  destination: Destination,
  event: LifecycleEvent,
  notification: Notification,
  dependencies: DeliveryDependencies,
): Promise<DeliveryOutcome> {
  switch (destination.transport) {
    case "webhook":
      return dependencies.sendWebhook(destination, event, notification);
    case "imessage":
      return dependencies.sendIMessage(destination, event, notification);
  }
}

function createReceipt(
  event: LifecycleEvent,
  destination: Destination | null,
  outcome: DeliveryOutcome,
  dependencies: DeliveryDependencies,
  durationMs: number,
): DeliveryReceipt {
  return {
    schemaVersion: 1,
    eventId: event.id,
    eventType: event.type,
    destination: destination?.id ?? null,
    transport: destination?.transport ?? null,
    driver: driverFor(destination),
    ...outcome,
    recordedAt: dependencies.now().toISOString(),
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}

function driverFor(destination: Destination | null): Driver | null {
  if (!destination) {
    return null;
  }

  return destination.transport === "imessage" ? "imsg" : "node-http";
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  requestedConcurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  const concurrency = Math.max(
    1,
    Math.min(Math.trunc(requestedConcurrency), values.length),
  );
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) {
          results[index] = await operation(value);
        }
      }
    }),
  );

  return results;
}
