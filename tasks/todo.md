# Codex Herald MVP tasks

## Task 1: Tooling foundation

**Acceptance criteria:**

- [x] Exact dependencies and Node engine are declared.
- [x] Build emits a plugin-local CLI bundle.
- [x] Lint, typecheck, test, and check scripts exist.

**Verification:** `npm run lint && npm run typecheck && npm test && npm run build`

**Dependencies:** None

**Files likely touched:** `package.json`, lockfile, TypeScript/Biome/build configs

## Task 2: Plugin package

**Acceptance criteria:**

- [x] Manifest uses `codex-herald` and display name `Herald for Codex`.
- [x] Stop hook invokes `${PLUGIN_ROOT}/bin/codex-herald` with a 60-second timeout.
- [x] Plugin validator passes.

**Verification:** Run the plugin-creator validator and parse both JSON files.

**Dependencies:** Task 1

**Files likely touched:** `.codex-plugin/plugin.json`, `hooks/hooks.json`, `bin/codex-herald`

## Task 3: Domain contracts

**Acceptance criteria:**

- [x] Event, destination, notification, and in-memory result unions are explicit.
- [x] Public status/error codes are bounded.
- [x] No external input enters typed core code without validation.

**Verification:** Typecheck and contract tests.

**Dependencies:** Task 1

**Files likely touched:** `src/domain/*`, `test/domain.test.ts`

## Task 4: Trusted config slice

**Acceptance criteria:**

- [x] TOML schema and route cross-references validate.
- [x] Lookup order matches the spec and never checks cwd.
- [x] Privacy defaults are applied and unsafe values rejected.

**Verification:** Config unit tests with isolated HOME/XDG/PLUGIN_DATA.

**Dependencies:** Task 3

**Files likely touched:** `src/config/*`, `test/config.test.ts`

## Task 5: Event/privacy slice

**Acceptance criteria:**

- [x] Codex Stop input is size-bounded and validated.
- [x] Stable event ids include message hash.
- [x] Summary truncation and generic fallback match privacy config.

**Verification:** Normalization and privacy unit tests.

**Dependencies:** Task 3

**Files likely touched:** `src/core/normalize.ts`, `src/core/privacy.ts`, tests

## Task 6: Stateless routing slice

**Acceptance criteria:**

- [x] Routes deduplicate destinations and deliver concurrently.
- [x] Accepted and failed immediate results use honest semantics.
- [x] No queue, retry, receipt, or runtime delivery file is created.
- [x] Repeating the same invocation makes a fresh attempt.

**Verification:** Router tests cover one-failure isolation, repeated invocation,
and absence of runtime delivery storage.

**Dependencies:** Tasks 4-5

**Files likely touched:** `src/core/router.ts`, `src/domain/types.ts`, tests

## Task 7: Secret and transport slices

**Acceptance criteria:**

- [x] Environment and Keychain references resolve without a shell.
- [x] Webhook enforces URL, redirect, and timeout policy.
- [x] imsg uses fixed `imessage` service and validates JSON success.

**Verification:** Loopback HTTP server and fake executable integration tests.

**Dependencies:** Tasks 4-6

**Files likely touched:** `src/config/secrets.ts`, `src/transports/*`, tests

## Task 8: CLI product slice

**Acceptance criteria:**

- [x] `ingest`, `setup`, `test`, and `doctor` implement the documented contract.
- [x] Hook success stdout is empty; destination failures emit one bounded
      `systemMessage`; fatal errors are redacted.
- [x] Text and JSON diagnostic output are stable.

**Verification:** Spawn the built CLI against temporary configs and fixtures.

**Dependencies:** Tasks 4-7

**Files likely touched:** `src/cli/*`, `src/cli.ts`, `test/cli.test.ts`

## Task 9: Documentation and automation

**Acceptance criteria:**

- [x] README covers setup, trust, config, semantics, privacy, and troubleshooting.
- [x] CI runs all local quality gates and audit.
- [x] Changelog and contributing guidance exist.

**Verification:** Link/command review plus local `npm run check`.

**Dependencies:** Task 8

**Files likely touched:** `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `.github/*`

## Task 10: Final review

**Acceptance criteria:**

- [x] Five-axis review has no unresolved critical/required finding.
- [x] Full suite, build, audit, and plugin validation pass.
- [x] Git diff contains no secrets or unrelated edits, and the generated bundle
      is current.

**Verification:** Final review report and command output.

**Dependencies:** Tasks 1-9

**Files likely touched:** Only files required to resolve review findings
