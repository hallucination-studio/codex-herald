# Implementation Plan: Codex Herald MVP

## Overview

Deliver a runnable, local-first TypeScript CLI packaged as a Codex plugin. Build
the domain and configuration contracts first, then add adapters, hook ingress,
diagnostic commands, documentation, and automated quality gates.

## Architecture decisions

- Official Codex `Stop` is normalized as the Herald route event
  `turn.finished`, with continuation caveats documented.
- User/plugin-private configuration only; repository discovery is forbidden.
- Adapters depend on injected process/fetch/clock/file boundaries for tests.
- Delivery is real-time and stateless: no queue, retry, receipt, or runtime
  delivery history.
- The plugin invokes a self-contained executable from `${PLUGIN_ROOT}`.

## Dependency graph

```text
Package/tooling
  -> domain contracts
     -> config + secret references
     -> event normalization + privacy
        -> routing + in-memory results
           -> webhook / imsg adapters
              -> ingest / setup / test / doctor CLI
                 -> plugin hook + docs + CI
```

## Phase 1: Foundation

- [x] Task 1: Create package, TypeScript, build, lint, and test configuration.
- [x] Task 2: Add plugin manifest, hook definition, and executable shim.
- [x] Task 3: Define public domain types and error codes.

### Checkpoint: Foundation

- [x] Empty test suite runs, type checking passes, bundle executes `--help`.
- [x] Plugin manifest validates.

## Phase 2: Core vertical slices

- [x] Task 4: Parse and validate user-level TOML config.
- [x] Task 5: Normalize Codex Stop input and apply privacy policy.
- [x] Task 6: Route one event to independent destinations and return immediate
      in-memory results.
- [x] Task 7: Prove that repeated invocations make fresh attempts without
      creating runtime delivery state.

### Checkpoint: Core

- [x] Config, privacy, routing, and stateless-repeat tests pass.
- [x] No test or production path reads a project-local config.

## Phase 3: Transport slices

- [x] Task 8: Resolve environment and Keychain secret references.
- [x] Task 9: Deliver to an HTTPS/private-opt-in webhook with redirects disabled
      and bounded request work.
- [x] Task 10: Deliver through `imsg` using an argv array and fixed iMessage mode.

### Checkpoint: Transports

- [x] Local webhook and fake-imsg integration tests cover success, failure, and
      timeout semantics.
- [x] One failed adapter does not prevent another adapter from succeeding.

## Phase 4: Product commands

- [x] Task 11: Implement non-interactive `ingest --source codex-stop`.
- [x] Task 12: Implement idempotent `setup`.
- [x] Task 13: Implement `test <destination>` and `doctor` text/JSON output.

### Checkpoint: CLI

- [x] `ingest` is silent on success and emits one bounded `systemMessage` for
      destination failures without changing Codex continuation.
- [x] CLI commands have stable exit codes and redacted output.

## Phase 5: Ship readiness

- [x] Task 14: Replace README and add examples/contribution guidance/changelog.
- [x] Task 15: Add GitHub Actions quality gates and dependency automation.
- [x] Task 16: Run full verification, security review, and independent code review.

### Checkpoint: Complete

- [x] All spec success criteria pass.
- [x] No critical/high dependency vulnerabilities.
- [x] Review findings are resolved and the working tree contains only intended
      project changes.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Another Stop hook continues the turn | Duplicate/premature notification | Document semantics; no cross-invocation deduplication is claimed |
| Hook PATH differs from shell PATH | imsg not found | PATH scanning, optional absolute executable, doctor capability probe |
| Malicious repository exfiltrates output | High | Never load project-local Herald config |
| Timeout after remote acceptance | Duplicate on manual repeat | Mark failure as uncertain and do not auto-retry |
| Plugin package lacks installed dependencies | Hook fails | Ship a self-contained bundle invoked from plugin root |
| Secrets leak into diagnostics | High | Bounded `systemMessage` fields and redaction tests |

## Open questions

- None blocking MVP. Email, other source agents, and public adapter SDK remain
  explicitly deferred.
