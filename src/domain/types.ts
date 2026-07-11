export const EVENT_TYPE = "turn.finished" as const;

export type EventType = typeof EVENT_TYPE;
export type Transport = "imessage" | "webhook";

export interface CodexStopInput {
  session_id: string;
  hook_event_name: "Stop";
  turn_id: string;
  cwd?: string | undefined;
  last_assistant_message: string | null;
}

export interface LifecycleEvent {
  id: string;
  type: EventType;
  source: "codex";
  sourceEvent: "Stop";
  project: string;
  occurredAt: string;
  summary: string | null;
}

export interface Notification {
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  truncated: boolean;
}

export type SecretReference =
  | { kind: "env"; name: string }
  | { kind: "keychain"; service: string; account: string };

export type ResolvableValue = { kind: "literal"; value: string } | SecretReference;

interface BaseDestination {
  id: string;
  timeoutMs: number;
}

export interface WebhookDestination extends BaseDestination {
  transport: "webhook";
  url: ResolvableValue;
  headers: Readonly<Record<string, SecretReference>>;
  allowInsecureHttp: boolean;
}

export interface IMessageDestination extends BaseDestination {
  transport: "imessage";
  driver: "imsg";
  recipient: string;
}

export type Destination = WebhookDestination | IMessageDestination;

export interface Route {
  events: readonly EventType[];
  destinations: readonly string[];
  template: "compact";
}

export interface PrivacyPolicy {
  includePrompt: false;
  includeSummary: boolean;
  maxChars: number;
}

export interface HeraldConfig {
  version: 1;
  destinations: Readonly<Record<string, Destination>>;
  routes: readonly Route[];
  privacy: PrivacyPolicy;
}

export type AcceptedCode = "imsg_accepted" | "webhook_accepted";
export type FailedCode =
  | "config_invalid"
  | "driver_failed"
  | "driver_invalid_response"
  | "driver_not_found"
  | "driver_terminated"
  | "driver_timeout"
  | "imessage_check_failed"
  | "imessage_not_ready"
  | "internal_error"
  | "secret_unavailable"
  | "webhook_http_error"
  | "webhook_network_error"
  | "webhook_timeout"
  | "webhook_unsafe_url";
export type DeliveryOutcome =
  | { status: "accepted"; code: AcceptedCode }
  | { status: "failed"; code: FailedCode };

export type DeliveryResult = { destination: string } & DeliveryOutcome;

export interface DeliveryDependencies {
  sendWebhook(
    destination: WebhookDestination,
    event: LifecycleEvent,
    notification: Notification,
  ): Promise<DeliveryOutcome>;
  sendIMessage(
    destination: IMessageDestination,
    event: LifecycleEvent,
    notification: Notification,
  ): Promise<DeliveryOutcome>;
}
