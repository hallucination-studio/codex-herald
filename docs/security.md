# Codex Herald security model

## Trust boundaries and assets

Untrusted inputs cross into Herald through Codex hook JSON, TOML configuration,
environment variables, Keychain output, process output, and HTTP responses.
Model-generated assistant text is data, never an instruction.

Protected assets are notification content, recipient identifiers, webhook
credentials, Keychain values, local paths, and reliable Codex lifecycle
behavior.

## Primary abuse cases

| Threat | Abuse case | MVP control |
| --- | --- | --- |
| Spoofing | A non-Codex caller sends arbitrary hook JSON | Validate the consumed Stop fields; treat input as untrusted |
| Tampering | Config references missing/changed destinations | Strict schema plus cross-reference validation |
| Repudiation | A send fails with no durable record | Surface a safe, bounded current-run warning; accept no historical audit trail by design |
| Information disclosure | A malicious repo adds an attacker webhook | Never discover config from cwd/git/project files |
| Information disclosure | Secrets leak through diagnostics or runtime state | No delivery store; warnings use bounded ids/codes and exclude sensitive fields |
| Denial of service | Huge stdin, hanging webhook, or hanging imsg | Input cap, adapter timeouts, and bounded fan-out |
| Elevation/injection | Recipient or path becomes a shell command | `execFile` with argument arrays and `shell: false`; no `eval` or command strings |

## Webhook policy

- HTTPS is required unless `allow_insecure_http = true` is explicitly set.
- URL userinfo is rejected.
- Redirects are disabled to prevent an allowed URL from redirecting to a less
  trusted target.
- URL and header-secret preparation plus the HTTP request share one deadline.
  Timeout cancellation stops Keychain work and prevents later header lookups.
- Response bodies are never consumed or persisted; the connection is closed
  after the HTTP status is classified.
- Destination hosts are trusted user configuration. MVP has no global host
  allowlist and does not classify or pin DNS answers; project-local config is
  prohibited instead.

## Secret policy

- `$ENV_VAR` and `keychain://service/account` are the supported secret sources.
- Header values must be secret references.
- Literal webhook URLs are allowed only for endpoints without embedded
  credentials; `doctor` warns for every literal URL because either its path or
  query may contain a token. Remote URLs should normally use a secret reference.
- Secret resolution errors identify the reference kind/name, never its value.
- Keychain access uses `/usr/bin/security` with argument arrays and a timeout.
- Webhook destinations are limited to 16 secret-backed headers.

## Local file and process policy

- Config files must be regular, owned by the current user, and inaccessible to
  group and other users. Setup creates them as `0600` in a `0700` directory.
- `setup --imessage-recipient` is an explicit outbound-send opt-in. The
  recipient is persisted only in the private config and is never echoed. The
  setup command and later `imsg --to` child process do
  receive it in argv, so shell history and same-user process inspection remain
  local-host considerations.
- Before every iMessage send, Herald runs a fixed `/usr/bin/osascript` readiness
  probe that reads only whether a Messages iMessage account is enabled and
  connected. The probe receives no recipient, notification body, account alias,
  chat, or transcript data and fails closed when its result is unavailable.
- Herald creates no queue, outbox, receipt file, retry ledger, or other runtime
  delivery history. There is no cross-invocation deduplication, so repeated or
  overlapping Hook processes may deliver a duplicate.
- iMessage is disabled outside macOS. On macOS, the user PATH is an explicit
  trust boundary. Herald resolves `imsg` to an absolute path and runs fixed argv
  without a shell or inherited secret environment.

## Privacy policy

- Prompt and transcript inclusion are unsupported in MVP.
- Only `last_assistant_message` may become a summary.
- Only the cleaned, 80-code-point final component of `cwd` may become the
  project label; the complete working-directory path is discarded.
- The summary is truncated before adapter invocation.
- Message bodies and delivery results are passed in memory and are not written
  to runtime delivery storage.
- The upstream `imsg` CLI accepts message text through `--text`, so the compact
  title and body are briefly present in that child process's argument list.
  Herald limits the child environment and never invokes a shell, but same-user
  process inspection remains a local-host consideration for highly sensitive
  summaries.
- Common secret redaction may reduce accidental leakage, but it is not a DLP
  guarantee; route only to destinations you trust.

## Hook safety

Herald never emits `decision: "block"`, `continue: false`, or exit code `2`.
Destination delivery failure cannot alter whether Codex continues. It exits `0`
and may emit one safe, length-bounded JSON `systemMessage` warning containing
only validated destination ids and stable failure codes. Fatal input,
configuration, or local errors may exit `1` with empty stdout and a stable,
redacted stderr diagnostic. The Stop hook budget is 60 seconds; legal fan-out is
bounded below it. The iMessage readiness probe and send process share one
destination deadline.

## Deferred security work

- Domain allowlists for organizations with stricter egress policy
- Signed webhook payloads
- Per-route privacy tightening
- Enterprise managed-hook policy and centralized configuration
