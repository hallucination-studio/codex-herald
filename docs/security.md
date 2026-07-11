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
| Spoofing | A non-Codex caller sends arbitrary hook JSON | Validate source name and full Stop shape; treat input as untrusted |
| Tampering | Config references missing/changed destinations | Strict schema plus cross-reference validation |
| Repudiation | A send fails with no usable record | Stable redacted receipts with event id and bounded code |
| Information disclosure | A malicious repo adds an attacker webhook | Never discover config from cwd/git/project files |
| Information disclosure | Secrets leak through logs or receipts | Field allowlist; never persist bodies, URLs, headers, recipients, or raw errors |
| Denial of service | Huge stdin, hanging webhook, or hanging imsg | Input cap, adapter timeouts, parallel bounded fan-out, receipt rotation |
| Elevation/injection | Recipient or path becomes a shell command | `spawn` with argument arrays and `shell: false`; no `eval` or command strings |
| Tampering | Two Hook processes deliver the same event concurrently | Per-event/destination owner-token lock plus a fresh durable receipt check |

## Webhook policy

- HTTPS is required for remote hosts.
- Private/loopback targets require `allow_private_network = true`; plain HTTP
  additionally requires `allow_insecure_http = true`.
- URL userinfo is rejected.
- Redirects are disabled to prevent an allowed URL from redirecting to a less
  trusted target.
- All A/AAAA records are classified before connection. Any non-public address
  fails unless private networking was explicitly enabled, and the request
  lookup is pinned to a validated address to close the DNS-rebinding gap.
- URL, DNS, header-secret preparation, and the HTTP request share one deadline.
  Timeout cancellation stops Keychain work and prevents later header lookups.
- Response bodies are never consumed or included in receipts; the connection is
  closed after the HTTP status is classified.
- Generic webhooks are intentionally user-configured, so there is no global
  host allowlist. Project-local config is prohibited instead.

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
- Receipt files and their owner-token lock directories are private. Lock cleanup
  removes only a dead process's unique owner record before removing an empty
  directory, avoiding stale-lock ABA deletion of a new owner.
- iMessage is disabled outside macOS. On macOS, Herald resolves `imsg` to an
  absolute path, rejects world-writable PATH directories and writable executable
  targets, and runs it without a shell or inherited secret environment.

## Privacy policy

- Prompt and transcript inclusion are unsupported in MVP.
- Only `last_assistant_message` may become a summary.
- The summary is truncated before adapter invocation.
- Message bodies are passed in memory and are not written to receipt storage.
- The upstream `imsg` CLI accepts message text through `--text`, so the body is
  briefly present in that child process's argument list. Herald limits the
  child environment and never invokes a shell, but same-user process inspection
  remains a local-host consideration for highly sensitive summaries.
- Common secret redaction may reduce accidental leakage, but it is not a DLP
  guarantee; route only to destinations you trust.

## Hook safety

Herald never emits `decision: "block"`, `continue: false`, or exit code `2`.
Destination delivery failure cannot alter whether Codex continues. Hook stdout
is empty; only fatal adapter errors may write a stable code and redacted stderr
diagnostic. The Stop hook budget is 60 seconds; legal fan-out is bounded below it.

## Deferred security work

- Domain allowlists for organizations with stricter egress policy
- Signed webhook payloads
- Per-route privacy tightening
- Enterprise managed-hook policy and centralized configuration
- Receipt retention command and configurable rotation limits
