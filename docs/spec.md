# Spec: Codex Herald MVP

## Objective

Build **Codex Herald** (display name **Herald for Codex**) as a local-first Codex
plugin and npm CLI that observes Codex `Stop` lifecycle facts, normalizes them as
`turn.finished`, applies user-owned routing and privacy policy, delivers a
channel-neutral notification to configured destinations, and reports only the
immediate result of each real-time send attempt.

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
- I can explicitly pass an iMessage recipient to `setup`; Herald writes the
  `phone` destination, verifies that Messages has an enabled and connected
  iMessage account, and immediately sends one check notification only when the
  account is ready.
- I can inspect the immediate `accepted` or `failed` result of an explicit test
  without exposing message bodies or secrets.
- Every lifecycle notification identifies Codex Herald, the source, the
  sanitized project basename, and the lifecycle event before any summary text.

## Source event semantics

Codex's official hook event is `Stop`. Herald exposes `turn.finished` as its
channel-independent route name for compatibility with the product vocabulary.
It means "Codex emitted a Stop fact for this turn," not "no other hook can
continue the turn." Another matching Stop hook may request continuation, so a
later Stop fact may occur for the same Codex turn.

Herald derives a stable event id from the Codex session id, turn id, hook name,
and a hash of the last assistant message for outbound event correlation. It does
not persist or look up that id. Destination names are deduplicated within one
invocation only. Repeated or overlapping Hook invocations can therefore make
the same send again.

## Tech stack

- Node.js 22 or newer, ESM
- TypeScript with strict type checking
- `smol-toml` for TOML parsing
- Zod for boundary validation and discriminated destination types
- Node built-ins for CLI parsing, HTTP(S), process spawning, hashing, and tests
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
codex-herald setup [--config <path>] [--force] [--imessage-recipient <recipient>]
codex-herald test <destination> [--config <path>] [--json]
codex-herald doctor [--config <path>] [--json]
codex-herald ingest --source codex-stop [--config <path>]
codex-herald --help
codex-herald --version
```

With `--imessage-recipient`, `setup` creates a single `phone` destination and
route, then reuses the same delivery path as `test phone`. Plain `setup` remains
side-effect free beyond writing the empty starter config. `ingest` is a
non-interactive hook adapter. It reads one JSON object from stdin and never asks
for input. Successful routing writes nothing; a destination failure may produce
one safe, length-bounded JSON `systemMessage` warning for Codex.

iMessage readiness is enforced at the transport boundary for setup checks,
explicit tests, doctor inspection, and Stop deliveries. Herald uses a fixed,
read-only Messages AppleScript probe and checks the first iMessage service that
the imsg v0.12.3 send path selects. Herald sends only when that service is
enabled and connected. It does not read account aliases, chats, or message
bodies.

Herald has no delivery queue, outbox, automatic retry, receipt store, or other
runtime delivery history. Each setup check, destination test, or Stop invocation
makes at most one real-time send attempt per matched destination and does not
persist notification content or delivery results. The setup notification uses
the same compact identity contract as a Stop delivery, but labels itself as
`Source: Codex Herald`, `Project: Setup`, and `Event: Delivery check`.

## Project structure

```text
.codex-plugin/plugin.json   Codex plugin manifest
hooks/hooks.json            Bundled Stop hook
bin/codex-herald            Plugin-local executable shim
src/cli/                    CLI parsing and command handlers
src/config/                 TOML loading, paths, schemas, secret references
src/domain/                 Stable event, notification, destination, result types
src/core/                   Normalization, privacy, routing, orchestration
src/transports/             Webhook and imsg adapters
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
- Resolved secrets are never included in command output, Hook warnings, or error
  messages.
- Webhook URLs must use HTTPS unless `allow_insecure_http = true`. Userinfo in
  a literal URL is rejected.
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
  project: string;
  occurredAt: string;
  summary: string | null;
};

type Notification = {
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  truncated: boolean;
};

type DeliveryOutcome =
  | { status: "accepted"; code: AcceptedCode }
  | { status: "failed"; code: FailedCode };

type DeliveryResult = {
  destination: string;
} & DeliveryOutcome;
```

For iMessage, the compact text contract is:

```text
Codex Herald
Source: Codex
Project: <sanitized cwd basename or Unknown>
Event: Turn finished

Summary:
<privacy-processed summary>
```

The project is capped at 80 Unicode code points and never contains the full
working-directory path. `privacy.max_chars` applies only to the summary, not
the identity header. Webhooks keep the same title and body in separate JSON
fields.

`DeliveryResult` exists only in memory for the current invocation. Its `code` is
a bounded machine-readable value; it contains no notification body, webhook
URL, headers, recipient, raw process output, exception text, timestamp, or
duration.

## Delivery behavior

- Matching routes are expanded and destination names are deduplicated.
- Destinations run concurrently and independently.
- Webhook `accepted` means the Node HTTP(S) client received an HTTP 2xx response.
- imsg `accepted` means the Messages account readiness check passed and `imsg`
  exited `0` with its expected JSON success shape.
- An unavailable iMessage account produces `failed/imessage_not_ready` without
  invoking `imsg send`. An unavailable or invalid readiness probe produces
  `failed/imessage_check_failed`.
- Neither status means the person or device received/read the notification.
- Readiness does not prove recipient reachability and never triggers an
  implicit fallback destination.
- Timeouts are failures with uncertain remote state. Herald never retries
  automatically; a manual or repeated Hook invocation may produce a duplicate.
- A missing route or missing user configuration produces no send, output, or
  runtime record and does not disrupt the Codex turn.
- There is no cross-invocation deduplication. Repeated or overlapping Hook
  invocations may send the same notification again.
- Notification content and delivery results remain in process memory only and
  are discarded when the invocation exits.

### Stop hook process contract

- stdin is capped and parsed as the documented Codex Stop object.
- Herald requires only `session_id`, `turn_id`, `hook_event_name = "Stop"`, and
  `last_assistant_message`. It optionally allowlists `cwd` solely to derive a
  cleaned project basename. Unknown and unrelated Codex fields are ignored.
- Exit `0` after routing completes, including when one or more destinations
  fail, so a notification failure cannot block or continue the Codex turn.
- On full success, missing configuration, or no matching route, stdout and
  stderr are empty.
- On destination failure, stdout contains one JSON object with a safe,
  length-bounded `systemMessage`; stderr remains empty. The warning identifies
  only bounded destination ids and stable failure codes and excludes content,
  recipients, URLs, secrets, local paths, raw output, and exception text.
- Exit `1` only for malformed or oversized hook input, invalid configured
  state, or another fatal local error. Fatal diagnostics are short, redacted,
  and written to stderr with empty stdout.
- Never exit `2`, return `decision: "block"`, or return `continue: false`, since
  those outputs would change Codex lifecycle behavior.
- The packaged Stop command has a 60-second timeout, exceeding the bounded
  40-second transport fan-out budget (32 destinations, concurrency 8, 10 seconds
  per adapter). iMessage readiness and send work share the same per-destination
  10-second deadline.

## Immediate diagnostics

Herald deliberately has no historical delivery query. Interactive commands may
print a transient accepted/failed result. The Stop Hook uses Codex's
`systemMessage` field only for a current destination failure, so the user gets a
warning without changing turn continuation behavior.

There is no audit trail, retry ledger, or post-hoc answer to which previous sends
were attempted. This is an explicit privacy and simplicity trade-off in the MVP.

## Code style

Prefer explicit discriminated unions and dependency injection at I/O boundaries:

```ts
export async function deliver(
  destination: Destination,
  notification: Notification,
  dependencies: DeliveryDependencies,
): Promise<DeliveryOutcome> {
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
  ids, secret parsing, URL policy, and in-memory result semantics.
- Boundary tests: webhook server on loopback; fake `imsg` executable; Keychain
  process adapter; stdin size/JSON handling; and proof that delivery attempts do
  not create runtime state files.
- CLI tests: plain setup, setup-and-check, `test`, `doctor`, and `ingest`
  exit/stdout/stderr contracts, including bounded `systemMessage` warnings.
- Plugin validation: official `plugin-creator` validator plus JSON parsing.
- CI gates: lint, typecheck, tests, build, plugin validation, and high-severity
  npm audit on pushes and pull requests.

Tests assert observable outcomes, not internal call order. External services are
replaced with localhost servers or executable fakes; no real messages are sent.

## Boundaries

### Always

- Validate all hook, config, environment, Keychain, process, and HTTP boundaries.
- Keep recipient choice entirely in user configuration.
- Keep `ingest` stdout empty except for the documented destination-failure
  `systemMessage` JSON.
- Preserve exact `accepted`/`failed` semantics.
- Run the full quality gate before handoff.

### Ask first

- Add a transport, event, template, hosted component, or public adapter SDK.
- Read project-local configuration or transcript content.
- Add automatic retries, queues, runtime delivery storage, or remote telemetry.
- Publish to npm or a Codex marketplace.

### Never

- Let model output select a destination or become a shell command.
- Read inbound messages or remotely control Codex.
- Persist delivery results, resolved secrets, notification bodies, prompts, or
  transcripts.
- Claim that a transport acceptance proves end-user delivery.

## Success criteria

- A valid Codex Stop fixture routes to webhook and fake imsg destinations in
  parallel and returns one in-memory result per destination.
- One failing destination does not prevent another from being accepted.
- `ingest` emits a bounded `systemMessage` for destination failure and never
  returns Codex continuation controls.
- Repeating the same Hook fixture makes a fresh attempt and creates no runtime
  delivery history.
- Config is never loaded from the active repository.
- `setup`, setup-and-check, `test`, and `doctor` work against an isolated
  temporary config.
- `npm run check`, plugin validation, and `npm audit --audit-level=high` pass.
- README documents installation, hook trust, configuration, privacy, semantics,
  troubleshooting, and the exact current `imsg` requirement.

## Open questions deferred beyond MVP

- Email transport and provider-specific drivers
- Rich templates and per-route privacy overrides
- Managed enterprise hook deployment
