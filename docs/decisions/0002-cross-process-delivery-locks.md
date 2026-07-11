# ADR-002: Use Owner-Token Directories for Delivery Locks

## Status

Accepted

## Date

2026-07-11

## Context

Codex may launch overlapping Stop hooks, and two Herald processes can observe
the same normalized event before either writes an accepted receipt. A
process-local memory mutex cannot coordinate them. A plain `O_EXCL` lock file
coordinates normal execution, but mtime-based stale cleanup has an ABA race: an
old cleaner can unlink a newer owner's file after the path has been reused.

Herald must prevent duplicate external sends without adding a daemon, database,
native advisory-lock dependency, or hosted service. It must also recover when a
process exits while holding a lock.

## Decision

Use one private lock directory per event/destination key. Directory creation is
atomic. The holder creates a uniquely named owner file containing its PID and
does not enter the delivery critical section until that file exists.

Contenders inspect owner records. They remove only the unique record of a PID
that is no longer alive, then remove the lock directory only if it is empty.
Because a later owner has a different filename, an older cleaner cannot delete
that record; its final `rmdir` fails while the newer directory is non-empty.

After acquiring the delivery lock, the repository rereads accepted receipts
from disk. The lock covers this check, the external send, and receipt append.

## Alternatives Considered

### In-memory mutex

Rejected because independent Hook processes do not share memory.

### Exclusive file plus mtime stale cleanup

Rejected because `stat` followed by `unlink` is not a compare-and-swap. Two
cleaners can remove an old file, reuse the pathname, and then unlink the new
owner's lock.

### Native `flock` dependency or helper process

Rejected for the MVP because Node has no portable built-in advisory lock API,
macOS and Linux expose different helpers, and a native dependency would weaken
the single-file plugin bundle.

## Consequences

- Duplicate suppression works across OS processes, not only within one CLI.
- Dead PID records can be recovered without deleting a later live owner.
- PID reuse can conservatively delay recovery until that unrelated process
  exits; this favors no duplicate delivery over availability.
- The receipt directory contains short-lived private lock directories in
  addition to NDJSON receipt files.
- Automated tests cover independent repositories, independent Node processes,
  and recovery from a dead owner record.
