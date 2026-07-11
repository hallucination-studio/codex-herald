# Spec: Codex Herald MVP

## Objective

Build **Codex Herald** (display name **Herald for Codex**) as a local-first Codex
plugin and npm CLI that observes Codex `Stop` lifecycle facts, normalizes them as
`turn.finished`, applies user-owned routing and privacy policy, delivers a
channel-neutral notification to configured destinations, and records an honest
delivery receipt.

The product boundary is **Outbound Lifecycle Delivery**. It does not accept
inbound commands, let the model select recipients, host user accounts, or claim
end-device delivery.

### MVP user stories

- As a Codex user, I can install a plugin whose trusted `Stop` hook invokes a
  packaged Herald executable.
- I can declare `destinations`, `routes`, and `privacy` in TOML stored outside
  the current repository.
- I can route a stopped turn to an arbitrary HTTPS webhook and/or iMessage via
  `imsg`.
- I can run `setup`, `test <destination>`, and `doctor` without triggering a
  Codex turn.
- I can inspect `accepted`, `failed`, and `skipped` receipts without exposing
  message bodies or secrets.

## Source event semantics

Codex's official hook event is `Stop`. Herald exposes `turn.finished` as its
channel-independent route name for compatibility with the product vocabulary.
It means "Codex emitted a Stop fact for this turn," not "no other hook can
continue the turn." Another matching Stop hook may request continuation, so a
later Stop fact may occur for the same Codex turn.

Herald derives a stable event id from the Codex session id, turn id, hook name,
and a hash of the last assistant message. Repeated identical events are skipped
per destination after an accepted receipt.

## Tech stack

- Node.js 22 or newer, ESM
- TypeScript with strict type checking
- `smol-toml` for TOML parsing
- Zod for boundary validation and discriminated destination types
- `ipaddr.js` for public/private IP classification at the webhook boundary
- Node built-ins for CLI parsing, HTTP(S), DNS, process spawning, hashing, and
  tests
- Biome for linting and formatting
- A single-file Node bundle for the plugin hook executable so it does not rely
  on a globally installed CLI or undeclared runtime state

All package versions are exact in `package.json` and reproducible through
`package-lock.json`.

## Commands

```text
npm ci                 Install exact dependencies
npm run build          Build the distributable CLI bundle
npm run typecheck      Type-check source and tests
npm run lint           Check formatting and lint rules
npm test               Build and run Node test suites
npm run check          Run lint, typecheck, tests, and build
npm audit --audit-level=high
```

Public CLI:

```text
codex-herald setup [--config <path>] [--force]
codex-herald test <destination> [--config <path>] [--json]
codex-herald doctor [--config <path>] [--json]
codex-herald ingest --source codex-stop [--config <path>]
codex-herald --help
codex-herald --version
```

`ingest` is a non-interactive hook adapter. It reads one JSON object from stdin,
writes nothing to stdout, and never asks for input.

## Project structure

```text
.codex-plugin/plugin.json   Codex plugin manifest
hooks/hooks.json            Bundled Stop hook
bin/codex-herald            Plugin-local executable shim
src/cli/                    CLI parsing and command handlers
src/config/                 TOML loading, paths, schemas, secret references
src/domain/                 Stable event, notification, destination, receipt types
src/core/                   Normalization, privacy, routing, orchestration
src/transports/             Webhook and imsg adapters
src/observability/          Receipt persistence and structured diagnostics
test/                       Unit and boundary integration tests
docs/                       Product, security, and architectural decisions
tasks/                      Implementation plan and checklist
```

## Public configuration contract

Default config lookup order:

1. `--config <path>`
2. `CODEX_HERALD_CONFIG`
3. `${XDG_CONFIG_HOME}/codex-herald/config.toml`
4. `~/.config/codex-herald/config.toml`

Herald never discovers config relative to `cwd`, the git root, or the active
repository. This prevents an untrusted repository from silently adding a
destination and exfiltrating lifecycle content.

```toml
version = 1

[destinations.phone]
transport = "imessage"
driver = "imsg"
recipient = "+8613800000000"

[destinations.ops]
transport = "webhook"
url = "$OPS_WEBHOOK_URL"
# allow_private_network = false
# allow_insecure_http = false

[[routes]]
events = ["turn.finished"]
destinations = ["phone", "ops"]
template = "compact"

[privacy]
include_prompt = false
include_summary = true
max_chars = 500
```

### Configuration rules

- `version` must equal `1`.
- Unknown keys are rejected so misspelled privacy or transport settings fail
  closed.
- Destination names must be non-empty identifiers and route references must
  resolve.
- Config limits are bounded: at most 32 destinations, 64 routes, 16 events per
  route, 32 destinations per route, and 16 webhook headers per destination.
- Config files must be regular, current-user-owned, and grant no group or
  other-user permissions.
- MVP event is `turn.finished`; MVP template is `compact`.
- `privacy.include_prompt` must be `false`. Herald never reads the unstable
  `transcript_path` hook file.
- `privacy.include_summary` defaults to `true`; `max_chars` defaults to `500`
  and is bounded to `1..4000`.
- Environment references use the exact form `$NAME`.
- Keychain references use `keychain://<service>/<account>` and are resolved via
  macOS `/usr/bin/security` without a shell.
- Resolved secrets are never included in output, receipts, or error messages.
- Webhook URLs must be HTTPS. Private/loopback destinations require
  `allow_private_network = true`; plain HTTP additionally requires
  `allow_insecure_http = true`. Userinfo in a literal URL is rejected.
- Webhook header values, when configured, must be environment or Keychain
  references.
- iMessage requires `driver = "imsg"`. Herald forces
  `--service imessage --json`; it never silently falls back to SMS.

## Stable domain interfaces

```ts
type LifecycleEvent = {
  id: string;
  type: "turn.finished";
  source: "codex";
  sourceEvent: "Stop";
  occurredAt: string;
  summary: string | null;
};

type Notification = {
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  truncated: boolean;
};

type DeliveryStatus = "accepted" | "failed" | "skipped";

type DeliveryReceipt = {
  schemaVersion: 1;
  eventId: string;
  eventType: "turn.finished";
  destination: string | null;
  transport: "imessage" | "webhook" | null;
  driver: "imsg" | "node-http" | null;
  status: DeliveryStatus;
  code: string;
  recordedAt: string;
  durationMs: number;
};
```

Receipt `code` is a bounded machine-readable value. Receipts never contain the
notification body, webhook URL, headers, recipient, raw process output, or
exception stack.

## Delivery behavior

- Matching routes are expanded and destination names are deduplicated.
- Destinations run concurrently and independently.
- Webhook `accepted` means an HTTP 2xx response was received by the DNS-pinned
  Node HTTP(S) client.
- imsg `accepted` means `imsg` exited `0` with its expected JSON success shape.
- Neither status means the person or device received/read the notification.
- Timeouts are failures with uncertain remote state and are not retried
  automatically, preventing duplicate messages.
- A missing route produces a `skipped/no_matching_route` receipt.
- A missing user configuration produces a `skipped/not_configured` receipt and
  does not disrupt the Codex turn.
- A previously accepted event/destination pair produces a
  `skipped/duplicate_event` receipt.
- Duplicate checks and sends are serialized per event/destination across OS
  processes. Accepted receipts are reread from disk after lock acquisition.
- Receipt persistence uses private directories/files and bounded NDJSON
  rotation. It is best-effort for individual destination failures but a hook
  input parse failure remains a fatal adapter error.

### Stop hook process contract

- stdin is capped and parsed as the documented Codex Stop object.
- Unknown input fields are ignored; required fields are validated.
- stdout is always empty.
- Exit `0` after routing completes, even when one or more destinations fail;
  those failures are represented by receipts.
- Exit `1` only for malformed hook input or a local failure before Herald can
  form a valid event/receipt.
- Never exit `2`, return `decision: "block"`, or return `continue: false`, since
  those outputs would change Codex lifecycle behavior.
- The packaged Stop command has a 60-second timeout, exceeding the bounded
  40-second transport fan-out budget (32 destinations, concurrency 8, 10 seconds
  per adapter).

## Observability questions

The receipt stream must answer:

1. Which destination attempts were made for a specific lifecycle event?
2. Which attempts were accepted, failed, or skipped, and with what bounded code?
3. How long did each adapter take, without revealing content or credentials?

Interactive diagnostics may print human-readable messages. Hook diagnostics are
structured, concise, redacted, and written only to stderr on fatal errors.

## Code style

Prefer explicit discriminated unions and dependency injection at I/O boundaries:

```ts
export async function deliver(
  destination: Destination,
  notification: Notification,
  dependencies: DeliveryDependencies,
): Promise<DeliveryReceipt> {
  switch (destination.transport) {
    case "webhook":
      return dependencies.sendWebhook(destination, notification);
    case "imessage":
      return dependencies.sendIMessage(destination, notification);
  }
}
```

- No `any`; use `unknown` only at external boundaries and validate immediately.
- No shell command construction from configuration.
- Errors cross public boundaries as stable codes plus redacted messages.
- Avoid generic adapter SDK abstractions beyond the two MVP transports.

## Testing strategy

- Unit tests: schema validation, route expansion, privacy truncation, stable event
  ids, secret parsing, URL policy, receipt redaction, duplicate detection.
- Boundary tests: webhook server on loopback; fake `imsg` executable; Keychain
  process adapter; stdin size/JSON handling; receipt file permissions.
- CLI tests: `setup`, `test`, `doctor`, and `ingest` exit/stdout/stderr contracts.
- Plugin validation: official `plugin-creator` validator plus JSON parsing.
- CI gates: lint, typecheck, tests, build, plugin validation, and high-severity
  npm audit on pushes and pull requests.

Tests assert observable outcomes, not internal call order. External services are
replaced with localhost servers or executable fakes; no real messages are sent.

## Boundaries

### Always

- Validate all hook, config, environment, Keychain, process, and HTTP boundaries.
- Keep recipient choice entirely in user configuration.
- Keep stdout empty for `ingest`.
- Preserve exact `accepted`/`failed`/`skipped` semantics.
- Run the full quality gate before handoff.

### Ask first

- Add a transport, event, template, hosted component, or public adapter SDK.
- Read project-local configuration or transcript content.
- Add automatic retries, queues, or remote telemetry.
- Publish to npm or a Codex marketplace.

### Never

- Let model output select a destination or become a shell command.
- Read inbound messages or remotely control Codex.
- Persist resolved secrets, notification bodies, prompts, or transcripts.
- Claim that a transport acceptance proves end-user delivery.

## Success criteria

- A valid Codex Stop fixture routes to webhook and fake imsg destinations in
  parallel and records one receipt per destination.
- One failing destination does not prevent another from being accepted.
- `ingest` writes no stdout and never returns Codex continuation controls.
- Config is never loaded from the active repository.
- `setup`, `test`, and `doctor` work against an isolated temporary config.
- `npm run check`, plugin validation, and `npm audit --audit-level=high` pass.
- README documents installation, hook trust, configuration, privacy, semantics,
  troubleshooting, and the exact current `imsg` requirement.

## Open questions deferred beyond MVP

- Email transport and provider-specific drivers
- Rich templates and per-route privacy overrides
- Receipt querying/retention commands
- Managed enterprise hook deployment
- Other agent sources such as Claude or Gemini
