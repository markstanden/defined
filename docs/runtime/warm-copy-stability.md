---
Area: runtime
Keywords: warm reuse, node_modules, scratch, verify, scan, comply, race, cpSync, stat bracket, node-coverage, no output, #67
Summary: A read-only verify/scan warm copy of live repo state could race a concurrent comply rebuild and silently copy a torn tree, then report the resulting failure as a compliance finding; a stat bracket now discards a drifting copy, ensureScratch retries and then errors as a raced pass, and an empty command render names the missing diagnostics.
---

# Warm copies are stability-bracketed, not just copy-if-no-throw

## Facts

- Incident (2026-11-24): a `scan --files` run reported
  `node-coverage: coverage command failed: exit 1: no output` while a `comply`
  ran on the same checkout. The scan was read-only and should not have failed.
- The chain: read-only `verify`/`scan` take no lock (#75 is comply-only by
  design); a comply fix pass reinstalls with `npm ci` **in the repo**; no-fix
  `node-deps` warm-copies repo `node_modules` into the scratch (#67); a copy
  that starts mid-rebuild succeeds silently with a torn tree. `node-checks`
  skips its tests check via `coverage.node.satisfies` (#66), so the tests run
  only inside `node-coverage`'s scratch — against the torn `node_modules`. The
  lcov-only reporter swallows the import failures, so the step renders
  `exit 1: no output`.
- The guard (`runtime/lib/node-packages.mts`, `runtime/lib/scratch.mts`): a
  copy is bracketed by the source's stat identity — `snapshotTree` records
  every entry as `mtimeMs:size`, `lstat` so a symlink is recorded as itself and
  never descended. `reuseWarmTree` discards a copy whose source drifted and
  falls back to a fresh install. `ensureScratch` brackets its tracked-file copy
  the same way, retries a torn copy up to three times, then throws
  `scratch copy could not be stabilised: a concurrent writer (comply or a
repair) is mutating <repo>`; `runStep` turns that into an errored pass, never
  a compliance finding.
- Diagnostics: `failureDetail` renders
  `no output — no diagnostics captured; a reporter may have consumed them` when
  both streams are empty, instead of a bare `no output`.
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
  `restored` (lib and step level), a scratch copy that races is re-copied, and
  a source that never stabilises throws the raced-pass error.
- A self-referential directory symlink is recorded without recursion.
- Suite 864/864; `./runtime/comply.sh` → `{"status":"compliant"}`; the ratchet
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
