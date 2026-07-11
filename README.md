# Codex Herald

**Herald for Codex**

> Route Codex lifecycle events to wherever you are.

Codex Herald is a local-first, user-routed lifecycle delivery plugin and CLI
for Codex. It observes Codex lifecycle facts, applies user-owned routing and
privacy policy, sends outbound notifications to configured destinations, and
records honest delivery receipts.

The project, npm package, CLI, and plugin slug are all
<code>codex-herald</code>. Version 0.1.0 is currently **unreleased**; use a
source checkout for development. There is not yet a published npm package or a
public Codex marketplace entry.

## Product boundary

Codex Herald owns one bounded context: **Outbound Lifecycle Delivery**.

It receives Codex lifecycle facts and delivers privacy-limited notifications
to destinations that the user declared in advance. It does not:

- accept commands from iMessage, email, or webhooks;
- let the model choose a recipient, destination, or privacy policy;
- act as a general workflow engine or hosted notification service;
- read prompts or a full transcript; or
- claim that transport acceptance proves a person or device received a message.

The model supplies lifecycle content. User configuration alone determines
where that content may go.

## Architecture

~~~text
Codex Stop
    ↓
Ingress / Normalizer
    ↓
Route policy
    ↓
Template / Privacy policy
    ↓
Destination
    ↓
Transport adapter
    ↓
Delivery receipt
~~~

| Term | Meaning |
| --- | --- |
| event | A lifecycle fact from Codex, normalized as <code>turn.finished</code> |
| route | A declaration of which events go to which destinations |
| destination | A user-configured target such as “my phone” or “ops webhook” |
| transport | A delivery type: <code>imessage</code> or <code>webhook</code> |
| driver | A concrete implementation: <code>imsg</code> or <code>node-http</code> |
| notification | Channel-neutral title, body, severity, and truncation state |
| delivery receipt | A redacted <code>accepted</code>, <code>failed</code>, or <code>skipped</code> result |

## Requirements

- **Node.js 22 or newer.** The package declares <code>node >=22</code>, and the
  distributable is bundled for Node 22.
- **A Codex client with plugin and lifecycle Hook support.** Plugin hooks must
  be enabled and explicitly trusted.
- **For iMessage only:** macOS 14 Sonoma or newer, Messages.app signed in,
  <code>imsg</code> available on the Codex host PATH, and Automation permission
  for the app that launches <code>imsg</code> to control Messages.

Herald does not execute <code>imsg</code> on non-macOS hosts. On macOS, the
user-provided PATH is an explicit trust boundary: Herald resolves
<code>imsg</code> to an absolute executable, then runs fixed argv without a
shell, from a safe cwd and with a minimal environment.

Codex Herald currently targets and tests the **imsg v0.12.3 CLI contract**. It
always selects iMessage explicitly and does not fall back to SMS:

~~~text
imsg send --to <recipient> --text <body> --service imessage --json
~~~

Install imsg using its documented Homebrew tap:

~~~bash
brew install steipete/tap/imsg
imsg --version
~~~

See the official [imsg installation guide](https://imsg.sh/install) and
[send command reference](https://imsg.sh/send). Automated tests use a fake
executable for the v0.12.3 command and JSON response shape; they do not send a
live iMessage.

## Develop from source

From a repository checkout:

~~~bash
npm ci
npm run check
./bin/codex-herald --help
~~~

<code>npm run check</code> runs linting, strict type checking, tests, and a
fresh bundle build. The generated executable is
<code>bin/codex-herald</code>.

To create the default user configuration:

~~~bash
./bin/codex-herald setup
~~~

The command creates the parent directory with mode <code>0700</code> and the
file with mode <code>0600</code>. It refuses to replace an existing config
unless <code>--force</code> is supplied. Herald also refuses to load a config
that grants any group or other-user permissions, including read-only access.

## Quick start with npx

After the npm release is published, download the CLI and create the private
user configuration in one command:

~~~bash
npx --yes codex-herald@latest setup
~~~

For a one-step iMessage setup, provide the recipient explicitly. Herald writes
the <code>phone</code> destination and immediately sends one check notification:

~~~bash
npx --yes codex-herald@latest setup --imessage-recipient "you@example.com"
~~~

The command exits <code>0</code> only when the check is accepted. If macOS
permission or Messages configuration blocks the send, it exits <code>1</code>
but keeps the valid config so you can authorize Messages and retry with
<code>codex-herald test phone</code>. The recipient is not printed or stored in
the receipt, although your shell may retain the command in its history.

This uses npm's execution cache and does not require a global CLI install. The
command creates the configuration directory with mode <code>0700</code> and
the config file with mode <code>0600</code>. Re-running it will not replace an
existing config unless you explicitly pass <code>--force</code>.

Running the CLI with <code>npx</code> does not by itself install or enable the
bundled Codex plugin. Version 0.1.0 is still unreleased, so the command above
becomes available only after the npm package is published.

After a Codex marketplace lists <code>codex-herald</code>, open the official
plugin browser and install it from that configured marketplace:

~~~text
codex
/plugins
~~~

Codex CLI also documents the selector form
<code>codex plugin add codex-herald@&lt;marketplace&gt;</code>, but this
repository does not yet publish a marketplace name that can replace the
placeholder. See the official [Codex plugin guide](https://developers.openai.com/codex/plugins)
and [plugin build guide](https://developers.openai.com/codex/plugins/build).

## Configure destinations and routes

Run <code>setup</code>, then edit the path printed by the command—normally
<code>~/.config/codex-herald/config.toml</code>. Declare at least one
<code>destination</code>, add a <code>route</code> that sends
<code>turn.finished</code> to it, and keep credentials in an environment
variable or macOS Keychain reference. The environment variable must be present
in the process that launches Codex, not only in an unrelated shell.

Copy [examples/config.toml](examples/config.toml), or replace the empty
destination and route tables produced by <code>setup</code> with:

~~~toml
version = 1

[destinations.phone]
transport = "imessage"
driver = "imsg"
# Reserved fictional NANP number; replace before use.
recipient = "+12025550123"

[destinations.ops]
transport = "webhook"
url = "$OPS_WEBHOOK_URL"
allow_insecure_http = false

[destinations.ops.headers]
Authorization = "keychain://codex-herald/ops-authorization"

[[routes]]
events = ["turn.finished"]
destinations = ["phone", "ops"]
template = "compact"

[privacy]
include_prompt = false
include_summary = true
max_chars = 500
~~~

Keep only the destinations you intend to use, and remove the same names from
the route. For example, a webhook-only setup should remove
<code>destinations.phone</code> and <code>"phone"</code>; otherwise
<code>doctor</code> will correctly report that <code>imsg</code> is not ready.

Set <code>OPS_WEBHOOK_URL</code> in the environment that launches Codex. The
Keychain item above uses service <code>codex-herald</code> and account
<code>ops-authorization</code>; its value must be the complete header value,
for example <code>Bearer …</code>. The same header could instead reference an
environment variable:

~~~toml
[destinations.ops.headers]
Authorization = "$OPS_AUTHORIZATION"
~~~

Validate the configuration and perform one real test delivery before trusting
the Hook:

~~~bash
npx --yes codex-herald@latest doctor
npx --yes codex-herald@latest test ops --json
~~~

<code>doctor</code> does not send a notification. <code>test</code> does, and
reports <code>accepted</code> only when the selected transport accepts the
request.

Supported secret references are exactly:

- <code>$ENV_VAR</code>, with an uppercase environment variable name; and
- <code>keychain://&lt;service&gt;/&lt;account&gt;</code>, resolved on macOS
  through <code>/usr/bin/security</code> without a shell.

Resolved secrets are not written to stdout, receipts, or error messages.
Literal HTTPS webhook URLs are allowed only for endpoints that contain no
credentials; <code>doctor</code> warns for every literal URL because tokens are
often embedded in either a path or query. Prefer a secret reference for remote
webhook URLs. Header values must always be secret references, with at most 16
headers per destination.

### Config lookup and the repository trust boundary

Herald resolves configuration in this order:

1. <code>--config &lt;path&gt;</code>;
2. absolute <code>CODEX_HERALD_CONFIG</code>;
3. <code>$XDG_CONFIG_HOME/codex-herald/config.toml</code>, when XDG config home
   is absolute; then
4. <code>~/.config/codex-herald/config.toml</code>.

It never searches the current directory, git root, or active repository for a
Herald config. This prevents an untrusted project from silently adding a
destination. An explicit <code>--config</code> remains a deliberate user
override, so prefer an absolute user-owned path.

Unknown keys and invalid route references are rejected. The only MVP event is
<code>turn.finished</code>, the only template is <code>compact</code>, and
<code>privacy.include_prompt</code> must remain <code>false</code>.

### Webhook safety

Webhook destinations use HTTPS by default. Herald rejects URL userinfo, does
not follow redirects, bounds secret preparation and the request with one
deadline, and closes response bodies immediately after classifying the status.

- Plain HTTP requires <code>allow_insecure_http = true</code>.
- Destination hosts are trusted user configuration. MVP does not classify or
  pin DNS answers, so it does not claim DNS-rebinding protection.

Only enable HTTP for a destination you control and understand. See the
[security model](docs/security.md) for the full trust-boundary analysis.

## Commands

| Command | Behavior |
| --- | --- |
| <code>codex-herald setup [--config PATH] [--force] [--imessage-recipient RECIPIENT]</code> | Create a safe starter config; an explicit iMessage recipient creates <code>phone</code> and immediately sends one check |
| <code>codex-herald test DESTINATION [--config PATH] [--json]</code> | Send a real test notification and print its receipt |
| <code>codex-herald doctor [--config PATH] [--json]</code> | Inspect config, secret readiness, imsg availability, receipt path, and Hook trust guidance without sending a notification |
| <code>codex-herald ingest --source codex-stop [--config PATH]</code> | Non-interactive adapter used by the bundled Stop Hook |
| <code>codex-herald --help</code> | Show CLI usage |
| <code>codex-herald --version</code> | Show the package version |

Run diagnostics after editing the config:

~~~bash
codex-herald doctor
codex-herald test phone
codex-herald test ops --json
~~~

<code>test</code> performs a real send. A test exits <code>0</code> only when
the adapter reports <code>accepted</code>; it exits <code>1</code> for failed
or skipped results. <code>doctor</code> exits <code>0</code> only when the
config, routes, and all configured destinations are ready. Interactive CLI
argument errors exit <code>2</code>; every <code>ingest</code> error exits
<code>1</code> so a usage failure can never become a Codex continuation signal.

## Trust the bundled Stop Hook

Installing or enabling a plugin does not automatically trust its command
hooks. In Codex, run:

~~~text
/hooks
~~~

Review the <code>codex-herald</code> Stop Hook and trust its exact definition.
Codex records trust against the current Hook hash, so an installed update or
local Hook change requires review again. Until trusted, Codex skips the Hook.

The packaged definition invokes the plugin-local executable through
<code>$PLUGIN_ROOT/bin/codex-herald</code>; it does not depend on a separately
installed global CLI. Its 60-second budget covers the bounded worst-case
32-destination fan-out. See the official [Codex Hooks documentation](https://developers.openai.com/codex/hooks).

## What turn.finished means

<code>turn.finished</code> is Herald's channel-neutral name for a Codex
<code>Stop</code> fact. It does **not** guarantee that the turn can never
continue.

Codex launches matching command hooks concurrently. Another Stop Hook may ask
Codex to continue the turn, which can lead to a later Stop event for the same
turn. Herald derives a stable event id from the session id, turn id, Stop name,
and last-assistant-message hash. Herald checks existing accepted receipts before
sending, but overlapping Hook processes may still race and deliver a duplicate.
A later continuation with different assistant text is a new lifecycle fact.

Herald itself never returns <code>decision: "block"</code>,
<code>continue: false</code>, or exit code <code>2</code> from its packaged
Hook invocation.

## Hook stdout and exit contract

<code>ingest</code> reads one size-bounded JSON object from stdin and is silent
on stdout.

| Result | Exit | Observable behavior |
| --- | ---: | --- |
| Valid event, including one or more destination failures | 0 | Failures are represented by receipts; Codex lifecycle behavior is unchanged |
| No user config | 0 | A <code>skipped/not_configured</code> receipt is recorded |
| Malformed or oversized Hook input | 1 | A short redacted diagnostic may be written to stderr |
| Fatal local failure before Herald can form a valid event/receipt | 1 | A short redacted diagnostic may be written to stderr |

The fixed packaged Hook arguments are valid, so CLI usage exit code
<code>2</code> is not part of its normal Hook path.

## Delivery receipts

Every attempted, skipped, or failed route produces a redacted NDJSON receipt.
Run <code>codex-herald doctor</code> to print the effective path.

Path precedence is:

1. absolute <code>CODEX_HERALD_RECEIPTS</code>;
2. <code>$PLUGIN_DATA/receipts.ndjson</code> for a plugin-launched Hook;
3. <code>$XDG_STATE_HOME/codex-herald/receipts.ndjson</code>; or
4. <code>~/.local/state/codex-herald/receipts.ndjson</code>.

Receipt directories and files are private, the active file rotates at 5 MiB,
and the previous file is retained as <code>receipts.ndjson.1</code>. Receipts
contain stable ids, destination names, adapter types, bounded result codes,
timestamps, and durations. They never contain notification bodies, webhook
URLs or headers, recipients, resolved secrets, raw process output, or exception
stacks.

Accepted receipts are checked on a best-effort basis before sending. This avoids
ordinary repeat invocations, but MVP does not claim exactly-once delivery across
overlapping Hook processes.

Receipt statuses are intentionally conservative:

- <code>accepted</code> for a webhook means Herald received HTTP 2xx.
- <code>accepted</code> for imsg means the process exited 0 and returned the
  expected <code>{"status":"sent"}</code> JSON shape.
- Neither meaning proves end-device delivery or that a person read the message.
- Timeouts are not retried automatically because the remote acceptance state
  may be uncertain.

Destinations are isolated and run with bounded concurrency. One failure does
not prevent another destination from being attempted.

## Privacy and security

Herald only uses Codex's <code>last_assistant_message</code> as the optional
summary. It does not parse <code>transcript_path</code>, whose format is not a
stable Hook interface. The summary is normalized, passed through common-secret
redaction, and truncated before any adapter runs. Redaction reduces accidental
leakage but is not a data-loss-prevention guarantee.

For the MVP:

- prompts and transcripts cannot be enabled;
- summaries default to enabled and 500 Unicode characters;
- destinations and recipients are fixed in user configuration;
- secret values remain in memory and out of receipt storage; and
- inbound messages and remote control are outside the product boundary.

Review the [MVP specification](docs/spec.md),
[security model](docs/security.md), and
[ADR-001: local-first plugin and CLI](docs/decisions/0001-local-first-plugin-and-cli.md)
before changing a public contract.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local workflow and quality gates.
Release-facing changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
