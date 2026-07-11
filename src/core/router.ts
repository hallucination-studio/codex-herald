import type {
  DeliveryDependencies,
  DeliveryOutcome,
  DeliveryResult,
  Destination,
  HeraldConfig,
  LifecycleEvent,
  Notification,
} from "../domain/types.js";

const DEFAULT_CONCURRENCY = 8;

export async function routeEvent(
  config: HeraldConfig,
  event: LifecycleEvent,
  notification: Notification,
  dependencies: DeliveryDependencies,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<DeliveryResult[]> {
  const destinationIds = matchingDestinations(config, event);

  return mapWithConcurrency(destinationIds, concurrency, async (destinationId) => {
    const destination = config.destinations[destinationId];
    if (!destination) {
      return {
        destination: destinationId,
        status: "failed",
        code: "config_invalid",
      };
    }

    let outcome: DeliveryOutcome;
    try {
      outcome = await send(destination, event, notification, dependencies);
    } catch {
      outcome = { status: "failed", code: "internal_error" };
    }

    return {
      destination: destination.id,
      ...outcome,
    };
  });
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
