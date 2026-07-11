# ADR-001: Ship a local-first Codex plugin backed by a standalone CLI

## Status

Accepted

## Date

2026-07-11

## Context

Codex Herald must observe Codex lifecycle facts and send privacy-limited,
user-routed notifications to local or remote destinations. The same delivery
engine must support an installed Codex plugin and direct diagnostic commands.

The primary risks are accidental repository-controlled exfiltration, dependence
on a global CLI installation, unstable transcript formats, and wording that
overstates transport acceptance as end-device delivery.

## Decision

Ship one repository as:

1. A Codex plugin with `.codex-plugin/plugin.json` and `hooks/hooks.json`.
2. A self-contained Node CLI bundle invoked through a plugin-local executable.
3. A user-level TOML configuration and stateless, real-time delivery engine.

The bundled hook observes official Codex `Stop` input and normalizes it to the
Herald route name `turn.finished`. It uses `last_assistant_message` only and
never parses `transcript_path`.

Herald keeps no delivery queue, outbox, automatic retry, receipt file, or other
runtime delivery history. It deduplicates destination names only within one
invocation. A repeated or overlapping Hook invocation may therefore send the
same notification again.

A destination failure does not change Codex turn continuation. The Stop Hook
exits `0` and may surface one safe, length-bounded `systemMessage` warning.
Malformed input, invalid configured state, or another fatal local error may
exit `1` with a redacted diagnostic. Herald never uses exit `2`,
`decision: "block"`, or `continue: false` for delivery reporting.

Configuration lookup is explicit/user-level. The active repository and current
working directory are never searched for Herald config.

## Alternatives considered

### Use Codex `notify` only

- Pros: small integration surface.
- Cons: project-scoped config cannot set `notify`, plugin packaging is weaker,
  and the current official hook API exposes the precise Stop fields Herald
  needs.
- Rejected: lifecycle hooks are the current supported extension point.

### Persist receipts or a deduplication outbox

- Pros: historical inspection and best-effort suppression of repeated events.
- Cons: creates sensitive runtime state, retention and locking policy, migration
  work, and a false impression of exactly-once delivery without eliminating
  races or uncertain transport timeouts.
- Rejected: the MVP favors a smaller privacy surface and immediate diagnostics.

### Require a globally installed `codex-herald`

- Pros: smaller plugin package.
- Cons: plugin installation would not guarantee PATH availability or CLI
  version compatibility.
- Rejected: the plugin must invoke its own packaged executable through
  `${PLUGIN_ROOT}`.

### Read `.codex-herald.toml` from each repository

- Pros: convenient project-specific routes.
- Cons: opening an untrusted repository could add an attacker-controlled
  webhook and exfiltrate assistant output.
- Rejected: project-local delivery destinations violate the trust boundary.

### Parse the Codex transcript for richer summaries

- Pros: more context and access to prompts.
- Cons: official documentation says the transcript format is not stable, and
  it expands the privacy surface dramatically.
- Rejected: use only stable Stop input fields in MVP.

### Hosted notification service

- Pros: easier cross-device setup and centralized delivery history.
- Cons: requires accounts, credential custody, data retention, and a cloud
  control plane outside the stated boundary.
- Rejected: the product is local-first and outbound-only.

## Consequences

- Plugin and CLI releases must remain version-aligned.
- Plugin hooks require separate user trust review after installation or change.
- `turn.finished` is explicitly documented as a normalization of a Stop fact,
  not proof that no hook continued the turn.
- User-level config is slightly less convenient than repo-local config but
  blocks a high-impact exfiltration path.
- There is no post-hoc delivery history or cross-invocation deduplication.
  Repeated Hook execution can produce duplicate notifications.
- Delivery failures are visible only through the current CLI result or Codex
  `systemMessage`; operators use `doctor` for follow-up diagnosis.
