---
Area: runtime
Keywords: warm reuse, node_modules, scratch, verify, scan, comply, race, cpSync, stat bracket, node-coverage, no output, #67
Summary: A read-only verify/scan warm copy of live repo state could race a concurrent comply rebuild and silently copy a torn tree, then report the resulting failure as a compliance finding; a stat bracket now discards (and removes) a drifting copy, ensureScratch retries and then errors as a raced pass, and the coverage step names empty output as possibly consumed by its reporter.
---

# Warm copies are stability-bracketed, not just copy-if-no-throw

## Facts

- Incident (2026-11-24): a read-only `scan --files` run reported
  `node-coverage: coverage command failed: exit 1: no output` while a `comply`
  ran on the same checkout (quoted step notice from the review record).
- Read-only `verify`/`scan` take no lock — #75 is comply-only by design — while
  a comply fix pass reinstalls with `npm ci` in the repo; no-fix `node-deps`
  copies the repo's `node_modules` into the scratch
  (`runtime/steps/node-deps.mts:133`). A copy that starts mid-rebuild succeeds
  silently with a torn tree.
- `coverage.node.satisfies` skips the tests check in `node-checks`
  (`runtime/steps/node-checks.mts:102`), so this repo's tests run only inside
  `node-coverage`'s scratch; the lcov-only reporter swallowed the import
  failures, which is why the step rendered an empty failure.
- `reuseWarmTree` brackets the copy with the source tree's stat identity
  (`runtime/lib/node-packages.mts:258-308`): `snapshotTree` records every entry
  as `mtimeMs:size` (`runtime/lib/scratch.mts:51`), with `lstat` so a symlink is
  recorded as itself and never descended. Drift discards the copy, and the
  destination is removed (`runtime/lib/node-packages.mts:307`) so the fallback
  install is genuinely fresh — yarn and pnpm frozen installs trust state files
  inside `node_modules`, so a torn tree left in place could make that install
  a no-op.
- A symlinked warm tree is never reused (`runtime/lib/node-packages.mts:293`):
  the bracket cannot see through the link, so the package installs fresh.
- `ensureScratch` brackets its tracked-file copy with `snapshotFiles`
  (`runtime/lib/scratch.mts:84`, used in `ensureScratch` at `:140`), retries a
  torn copy — three attempts in total (`SCRATCH_ATTEMPTS`,
  `runtime/lib/scratch.mts:38`) — then throws
  `scratch copy could not be stabilised: a concurrent writer (comply or a
repair) is mutating <repo>` (`:164`). `runStep` turns that into an errored
  pass (`runtime/comply.mts:469-479`), never a compliance finding.
- Diagnostics: the shared renderer names empty output honestly as `no output`
  (`lib/proc.mts:302`); only the coverage-scoped renderer adds the likelier
  cause, where a reporter is known to consume its own output
  (`runtime/lib/coverage.mts:78`).
- Soundness ceiling: a same-name, same-size, same-mtime rewrite inside the
  filesystem's timestamp granularity is undetectable. npm's rm+create mutation
  and whole-file repairs change an entry, an mtime or a size, so they are
  always seen. Over-discard degrades to a fresh install — the correct trade.
- Cost: two recursive stat walks of the warm tree per reuse (tens of ms warm),
  negligible against the `npm ci` it replaces.
- The no-lock design is unchanged: this closes scan/verify **versus a
  write-capable pass**, not two scans racing the tree.

## Inferred

- The bracket is writer-agnostic: any concurrent mutation between the two
  snapshots (a repair, another comply) makes the copy unprovable and discarded.
- CI `verify` is unaffected: one run, stable source, reuse behaves as before.

## Tested

- Red-first regression tests at all three seams: a mutating warm copy becomes
  `restored` and leaves no destination behind, an entry that appears mid-copy
  is drift, a symlinked warm tree is never reused, a scratch copy that races is
  re-copied, and a source that never stabilises throws the raced-pass error
  (`runtime/lib/node-packages.test.mts`, `runtime/lib/scratch.test.mts`).
- A self-referential directory symlink is recorded without recursion
  (`runtime/lib/scratch.test.mts`).
- Suite 865/865; `./runtime/comply.sh` → `{"status":"compliant"}`; the ratchet
  `scan --files` over every touched file compliant.
- The `/tmp` timing demonstration (source rebuilt under a concurrent `cpSync`,
  10/10 silent partial copies) stays a manual demonstration, not a suite test.

## Open questions

- A persistent non-race copy failure (permissions) also surfaces the
  raced-pass message after three attempts; the message names the likely writer,
  which would be wrong there. Accepted ceiling; split the error kinds if it
  bites.
- Fix-mode manifest-match install skipping (the adjacent perf win that narrows
  but does not close the window) is noted, not applied.
