# Contributing to Codex Herald

Thank you for helping improve Codex Herald. The project is intentionally narrow:
it delivers Codex lifecycle notifications outward according to user-owned
routing and privacy policy. Changes that add inbound control, model-selected
recipients, project-discovered configuration, or hosted account infrastructure
need a new product decision before implementation.

## Read the contracts first

Before changing behavior, read:

- the [MVP specification](docs/spec.md);
- the [security model](docs/security.md); and
- [ADR-001](docs/decisions/0001-local-first-plugin-and-cli.md).

The public vocabulary and status semantics are part of the product contract.
In particular, <code>accepted</code> is transport acceptance, never proof of
end-user delivery.

## Prerequisites

- Node.js 22 or newer
- npm 11 (the repository pins <code>npm@11.6.2</code>)
- macOS 14 or newer plus imsg only when manually exercising iMessage
- A Codex client with lifecycle Hook support for plugin integration testing

Automated tests do not require a live iMessage account or a public webhook.

## Set up the repository

~~~bash
npm ci
npm run check
~~~

The first command installs the exact lockfile. The quality gate runs linting,
strict type checking, tests, and a fresh production bundle.

Useful individual commands:

| Command | Purpose |
| --- | --- |
| <code>npm run lint</code> | Check Biome formatting and lint rules |
| <code>npm run format</code> | Apply Biome fixes |
| <code>npm run typecheck</code> | Type-check source and test TypeScript |
| <code>npm test</code> | Compile and run the Node test suite |
| <code>npm run build</code> | Rebuild <code>bin/codex-herald</code> |
| <code>npm run check</code> | Run the complete local quality gate |
| <code>npm audit --audit-level=high</code> | Fail on high or critical dependency advisories |
| <code>npm pack --dry-run</code> | Inspect the package contents after the prepack gate |

If a configured registry mirror does not implement npm's audit endpoint, run
the same check against the official registry:

~~~bash
npm audit --audit-level=high --registry=https://registry.npmjs.org
~~~

Run the built CLI directly:

~~~bash
./bin/codex-herald --help
./bin/codex-herald --version
~~~

## Make focused changes

- Keep changes small and independently reviewable.
- Preserve strict boundary validation for Hook JSON, TOML, secrets, processes,
  HTTP, and persisted receipts.
- Do not introduce a generic adapter SDK for an MVP-only use case.
- Do not discover configuration relative to the current directory or git root.
- Do not parse <code>transcript_path</code>.
- Do not make destination failures alter Codex continuation behavior.
- Update the generated <code>bin/codex-herald</code> with
  <code>npm run build</code> when source behavior changes.

Use commit subjects such as <code>feat: ...</code>, <code>fix: ...</code>,
<code>test: ...</code>, and <code>docs: ...</code>. Keep refactors separate
from behavior changes where practical.

## Test safely

Tests must be deterministic and local:

- use a fake executable for imsg;
- use loopback HTTP servers for webhook tests;
- inject environment, Keychain, process, clock, and filesystem boundaries;
- never send a real message from the automated suite; and
- never place live recipients, URLs with credentials, tokens, prompts, or
  notification bodies in fixtures or snapshots.

<code>codex-herald test &lt;destination&gt;</code> performs a real delivery
attempt. Use it only with a destination you own and intend to contact.

When testing config behavior manually, use a temporary user-owned path rather
than adding a project config:

~~~bash
config_dir="$(mktemp -d)"
./bin/codex-herald setup --config "$config_dir/config.toml"
./bin/codex-herald doctor --config "$config_dir/config.toml"
~~~

## Preserve the Hook contract

The packaged <code>ingest --source codex-stop</code> path has stricter output
rules than interactive commands:

- stdout stays empty;
- a valid event exits 0 even when a destination fails;
- malformed Hook input or an unrecoverable local failure exits 1;
- delivery outcomes are represented by redacted receipts; and
- Herald does not emit continuation controls such as
  <code>decision: "block"</code> or <code>continue: false</code>.
- Usage failures on this path exit 1, never the Codex continuation code 2.

Add or update CLI process tests whenever this contract changes.

## Documentation and release notes

Update README examples when user-facing commands, config, requirements, receipt
paths, or transport semantics change. Update [CHANGELOG.md](CHANGELOG.md) in the
same change as a user-visible modification.

Significant architectural or trust-boundary changes need a new ADR that
supersedes, rather than deletes, an earlier decision.

## Pull request checklist

- [ ] The change stays inside the Outbound Lifecycle Delivery boundary.
- [ ] New behavior has tests at the appropriate boundary.
- [ ] <code>npm run check</code> passes.
- [ ] <code>npm audit --audit-level=high</code> passes.
- [ ] The diff contains no secrets, personal recipients, or generated test data.
- [ ] README, security documentation, spec, ADRs, and changelog are updated as
      required.
- [ ] Public output uses <code>accepted</code>, <code>failed</code>, and
      <code>skipped</code> honestly.
