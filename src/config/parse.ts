import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { HeraldError } from "../domain/errors.js";
import type {
  Destination,
  HeraldConfig,
  ResolvableValue,
  SecretReference,
  WebhookDestination,
} from "../domain/types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DESTINATIONS = 32;
const MAX_WEBHOOK_HEADERS = 16;
const DESTINATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENV_REFERENCE_PATTERN = /^\$([A-Z_][A-Z0-9_]*)$/;
const KEYCHAIN_REFERENCE_PATTERN = /^keychain:\/\/([^/?#]+)\/([^/?#]+)$/;

const webhookSchema = z.strictObject({
  transport: z.literal("webhook"),
  url: z.string().min(1),
  headers: z.record(z.string().min(1), z.string()).optional().default({}),
  allow_insecure_http: z.boolean().optional().default(false),
});

const imessageSchema = z.strictObject({
  transport: z.literal("imessage"),
  driver: z.literal("imsg"),
  recipient: z.string().trim().min(1),
});

const rawConfigSchema = z.strictObject({
  version: z.literal(1),
  destinations: z.record(
    z.string(),
    z.discriminatedUnion("transport", [webhookSchema, imessageSchema]),
  ),
  routes: z
    .array(
      z.strictObject({
        events: z.array(z.literal("turn.finished")).min(1).max(16),
        destinations: z.array(z.string()).min(1).max(32),
        template: z.literal("compact"),
      }),
    )
    .max(64),
  privacy: z.strictObject({
    include_prompt: z.literal(false),
    include_summary: z.boolean().optional().default(true),
    max_chars: z.number().int().min(1).max(4000).optional().default(500),
  }),
});

type RawConfig = z.output<typeof rawConfigSchema>;

export function parseConfigText(text: string): HeraldConfig {
  let parsedToml: unknown;
  try {
    parsedToml = parseToml(text);
  } catch {
    throw invalidConfig("Configuration is not valid TOML");
  }

  if (containsPrototypeKey(parsedToml)) {
    throw invalidConfig("Configuration contains a forbidden table key");
  }

  const result = rawConfigSchema.safeParse(parsedToml);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw invalidConfig(`Configuration does not match the supported schema${location}`);
  }

  return buildConfig(result.data);
}

function buildConfig(raw: RawConfig): HeraldConfig {
  const entries = Object.entries(raw.destinations);
  if (entries.length > MAX_DESTINATIONS) {
    throw invalidConfig(
      `Configuration supports at most ${MAX_DESTINATIONS} destinations`,
    );
  }

  const destinationEntries: Array<[string, Destination]> = [];
  for (const [id, destination] of entries) {
    if (!DESTINATION_ID_PATTERN.test(id)) {
      throw invalidConfig(`Invalid destination identifier: ${id || "<empty>"}`);
    }

    const parsedDestination: Destination =
      destination.transport === "imessage"
        ? {
            id,
            transport: "imessage",
            driver: "imsg",
            recipient: destination.recipient,
            timeoutMs: DEFAULT_TIMEOUT_MS,
          }
        : buildWebhookDestination(id, destination);
    destinationEntries.push([id, parsedDestination]);
  }
  const destinations = Object.fromEntries(destinationEntries);

  for (const route of raw.routes) {
    for (const destination of route.destinations) {
      if (!Object.hasOwn(destinations, destination)) {
        throw invalidConfig(`Route references unknown destination: ${destination}`);
      }
    }
  }

  return {
    version: 1,
    destinations,
    routes: raw.routes.map((route) => ({
      events: route.events,
      destinations: route.destinations,
      template: route.template,
    })),
    privacy: {
      includePrompt: false,
      includeSummary: raw.privacy.include_summary,
      maxChars: raw.privacy.max_chars,
    },
  };
}

function buildWebhookDestination(
  id: string,
  raw: z.output<typeof webhookSchema>,
): WebhookDestination {
  const headerEntries: Array<[string, SecretReference]> = [];
  const rawHeaderEntries = Object.entries(raw.headers);
  if (rawHeaderEntries.length > MAX_WEBHOOK_HEADERS) {
    throw invalidConfig(
      `Webhook destinations support at most ${MAX_WEBHOOK_HEADERS} headers`,
    );
  }
  for (const [name, value] of rawHeaderEntries) {
    const reference = parseSecretReference(value);
    if (!reference) {
      throw invalidConfig(`Webhook header ${name} must use a secret reference`);
    }
    headerEntries.push([name, reference]);
  }
  const headers = Object.fromEntries(headerEntries);

  const url = parseResolvableUrl(raw.url, raw.allow_insecure_http);

  return {
    id,
    transport: "webhook",
    url,
    headers,
    allowInsecureHttp: raw.allow_insecure_http,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function parseResolvableUrl(
  value: string,
  allowInsecureHttp: boolean,
): ResolvableValue {
  const reference = parseSecretReference(value);
  if (reference) {
    return reference;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidConfig("Webhook URL must be an absolute URL or secret reference");
  }

  if (url.username || url.password) {
    throw invalidConfig("Webhook URL must not contain userinfo");
  }

  if (url.protocol === "http:") {
    if (!allowInsecureHttp) {
      throw invalidConfig("Plain HTTP webhooks require allow_insecure_http = true");
    }
  } else if (url.protocol !== "https:") {
    throw invalidConfig("Webhook URL must use HTTPS");
  }

  return { kind: "literal", value };
}

function parseSecretReference(value: string): SecretReference | undefined {
  const environment = ENV_REFERENCE_PATTERN.exec(value);
  if (environment?.[1]) {
    return { kind: "env", name: environment[1] };
  }

  const keychain = KEYCHAIN_REFERENCE_PATTERN.exec(value);
  if (keychain?.[1] && keychain[2]) {
    return {
      kind: "keychain",
      service: keychain[1],
      account: keychain[2],
    };
  }

  return undefined;
}

function containsPrototypeKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (Object.hasOwn(value, "__proto__")) {
    return true;
  }

  return Object.values(value).some(containsPrototypeKey);
}

function invalidConfig(message: string): HeraldError {
  return new HeraldError("CONFIG_INVALID", message);
}
