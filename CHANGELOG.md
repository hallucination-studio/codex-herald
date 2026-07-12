# Changelog

All notable changes to Codex Herald will be documented in this file. The
project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-12

Initial MVP.

### Added

- Local-first Codex plugin packaging with a plugin-local Stop Hook and Codex
  trust review.
- <code>codex-herald</code> CLI commands for <code>setup</code>,
  <code>test</code>, <code>doctor</code>, and non-interactive
  <code>ingest</code>.
- One-step iMessage setup with an explicit recipient and immediate check
  notification using honest transport-acceptance semantics.
- Normalization of Codex Stop facts to the channel-neutral
  <code>turn.finished</code> route event.
- Strict TOML destinations, routes, compact templates, and summary privacy
  policy.
- Independent webhook and iMessage delivery through the Node HTTP client and
  imsg driver.
- Stateless real-time delivery with no queue, outbox, automatic retry, receipt
  store, or other runtime delivery history.
- Node 22 TypeScript build, lint, test, packaging, and audit workflows.

### Fixed

- Prevented disconnected or disabled Messages accounts from producing false
  iMessage acceptance results by checking live account readiness before every
  send and during `doctor`.
- Made lifecycle iMessages self-identifying with a fixed Codex Herald title,
  source, sanitized project basename, event, and summary; setup checks use an
  explicit Setup context.
- Kept destination delivery failures non-blocking with exit code `0` and a safe,
  length-bounded Codex `systemMessage`; fatal input, configuration, and local
  errors still use exit code `1` with redacted stderr.
- Made the packaged CLI recognize canonicalized and symlinked entry paths.
- Bounded webhook URL, secret-header, and HTTP work under one cancellable
  deadline and closed successful streaming responses immediately.

### Security

- Configuration is resolved only from explicit or user-level paths and is
  never discovered from the active repository.
- Environment and macOS Keychain references keep resolved secrets out of config
  output, diagnostics, and runtime delivery storage.
- Webhooks default to HTTPS and enforce URL validation, redirect refusal,
  timeouts, secret-backed headers, and an explicit insecure-HTTP opt-in.
- Hook input, config, process output, and Hook warnings are size-bounded and
  validated at their trust boundaries.
- Config files must be owner-only, fatal Hook diagnostics redact local paths,
  and <code>imsg</code> runs through a resolved absolute path with fixed argv,
  no shell, bounded output, and a minimal environment.

### Known limitations

- Codex Herald is not yet available through a public Codex marketplace.
- Email, rich templates, inbound control, hosted delivery, and a public adapter
  SDK are outside the MVP.
- iMessage delivery requires macOS 14 or newer and targets the imsg v0.12.3 CLI
  contract.
- Repeated or overlapping Hook invocations may send duplicate notifications;
  the MVP has no cross-invocation deduplication or historical delivery log.
