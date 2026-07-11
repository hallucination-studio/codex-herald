# Changelog

All notable changes to Codex Herald will be documented in this file. The
project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

Initial MVP.

### Added

- Local-first Codex plugin packaging with a plugin-local Stop Hook and Codex
  trust review.
- <code>codex-herald</code> CLI commands for <code>setup</code>,
  <code>test</code>, <code>doctor</code>, and non-interactive
  <code>ingest</code>.
- Normalization of Codex Stop facts to the channel-neutral
  <code>turn.finished</code> route event.
- Strict TOML destinations, routes, compact templates, and summary privacy
  policy.
- Independent webhook and iMessage delivery through the Node HTTP client and
  imsg driver.
- Redacted <code>accepted</code>, <code>failed</code>, and
  <code>skipped</code> NDJSON receipts with duplicate-event suppression and
  bounded rotation.
- Node 22 TypeScript build, lint, test, packaging, and audit workflows.

### Fixed

- Kept every ingest failure on exit code 1 with empty stdout so Codex never
  interprets a usage error as a Stop continuation request.
- Serialized duplicate checks across processes and recovered locks left by dead
  owners without stale-lock ABA races.
- Bounded webhook URL, DNS, secret-header, and HTTP work under one cancellable
  deadline; corrected Node 22 DNS-pinned hostname lookup behavior and closed
  successful streaming responses immediately.
- Made concurrent non-force setup an exclusive create instead of allowing
  multiple callers to replace the same new config.

### Security

- Configuration is resolved only from explicit or user-level paths and is
  never discovered from the active repository.
- Environment and macOS Keychain references keep resolved secrets out of config
  output, diagnostics, and receipts.
- Webhooks default to remote HTTPS and enforce URL validation, DNS address
  classification, DNS pinning, redirect refusal, timeouts, and explicit
  private-network and insecure-HTTP opt-ins.
- Hook input, config, process output, and receipt storage are size-bounded and
  validated at their trust boundaries.
- Config files must be owner-only, fatal Hook diagnostics redact local paths,
  and untrusted <code>imsg</code> PATH entries are rejected without breaking
  standard current-user Homebrew directories.

### Known limitations

- Version 0.1.0 has not yet been published to npm or a public Codex marketplace.
- Email, other AI-agent sources, rich templates, inbound control, hosted
  delivery, and a public adapter SDK are outside the MVP.
- iMessage delivery requires macOS 14 or newer and targets the imsg v0.12.3 CLI
  contract.
