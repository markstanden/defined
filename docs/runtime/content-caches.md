---
Area: runtime
Date: 2026-10-04
Keywords: content cache, per-file cache, FileCache, partitionByHash, identityHash, hashFile, prettier, eslint, node step, verifyEslint, DEFINED_CACHE_DIR, named volume, read-only verify, timings, cache metrics, issue 68
Summary: How the gate reuses per-file prettier/eslint verdicts across iterations (#68) — identity is tool versions + house config + ignore/editorconfig + `.defined.json` overrides; the cache lives on a pin+repo named volume outside the read-only checkout, and hits report under `--timings`.
---

# Content-based format/lint caches (`runtime/lib/cache.mts`, #68)

Issue #68 memoises the prettier (node) and eslint no-fix verdicts per file, so a
repeated gate iteration over a large checkout re-runs only what changed. Claims
are tagged per `~/.config/opencode/EVIDENCE-TAGS.md`.

## What changed

`[FACT]` `runtime/lib/cache.mts` is new: a content-addressed per-file verdict
cache. One manifest per step lives at `<dir>/<step>.json`; an entry is keyed by
`sha256(CACHE_FORMAT + identity + path + content-hash)` (`keyFor`,
`runtime/lib/cache.mts:216`), and the identity is the `sha256` of the sorted
labelled parts (`identityHash`, `runtime/lib/cache.mts:59`).

`[FACT]` The node (prettier) no-fix pass routes through `verifyNode`
(`runtime/steps/node.mts:309`); eslint through `verifyEslint`
(`runtime/steps/eslint.mts:481`). Both call `partitionByHash`
(`runtime/lib/cache.mts:106`) to split the scope into cached verdicts and the
files that must be re-run, then merge in file order so a cached and an uncached
run produce the same diagnostics.

`[FACT]` Caching is bypassed for the repair (`fix`) pass, and for a
consumer-owned prettier or eslint config — `nodeFileCache`
(`runtime/steps/node.mts:463`) and `eslintFileCache`
(`runtime/steps/eslint.mts:611`) return `undefined` in those cases, which is the
whole-scope fallback (one tool invocation, exactly the pre-#68 behaviour).

## Identity — what invalidates

`[FACT]` Both steps include the pinned tool/plugin versions (the sha256 of
`runtime/tool-versions.env`, via `toolVersionsPath`) and the byte hash of the
effective house config (`prettier.config.mjs` / `eslint.config.mjs`).

`[FACT]` Prettier additionally hashes its ignore policy — the house
`prettierignore`, a tracked `.prettierignore`, and **every tracked
`.editorconfig`** read from the working root. ESLint additionally hashes the two
`.defined.json` values its house config reads: the effective
`DEFINED_ESLINT_COMPLEXITY_MAX` (`default` / `off` / N) and
`DEFINED_ESLINT_REQUIRE_JSDOC` (`default` / `on` / `off`).

`[INFERRED]` `.editorconfig` must be part of prettier's identity because
prettier reads it natively and it overrides `--config`; omitting it would serve
stale verdicts after an editorconfig edit. The hashing is unit-tested
(`hashFile`); the end-to-end editorconfig edit is not.

## Storage and the read-only-verify constraint

`[FACT]` Read-only `verify` mounts the checkout `:ro`, so the cache cannot live
inside the repo. It lives under `DEFINED_CACHE_DIR` (default
`<home>/.cache/defined`, `resolveCacheDir`, `runtime/lib/cache.mts:40`), and the
launcher and source shim mount a named volume keyed by pin + repo:
`defined-cache-<pin>-<repo_hash>:/home/node/.cache/defined` (`cli/defined`,
`runtime/comply.sh`). The image creates the directory and sets
`DEFINED_CACHE_DIR` (`runtime/Containerfile`).

`[FACT]` The manifest is written atomically (temp file + rename) and any read,
parse or write failure is swallowed and degrades to a miss (`loadManifest`,
`runtime/lib/cache.mts:142`; `writeManifest`, `:169`) — a cache failure is a lost
optimisation, never a gate failure.

`[FACT]` The manifest is rebuilt each run: only entries touched this run are
written, so a deleted file leaves no key (test "flush drops entries not touched
this run").

## Reporting

`[FACT]` The stdout contract is one JSON result line, and a step's `notice` is
only rendered when a failing step has no diagnostics of its own
(`runtime/lib/report.mts`), so cache counts cannot ride it.

`[FACT]` Cache metrics therefore ride the same opt-in `--timings` stderr sink:
`defined: cache <step> hit=<n> miss=<m>` (`reportCacheMetric`,
`runtime/lib/cache.mts:257`). The sink is threaded as `StepInput.notify` and
passed to the passes only when `timings` is on (`runtime/comply.mts:917`, `:927`).

## Measured effect (2026-10-04, `add-content-format-lint-caches` @ `20c73b1`)

`[FACT]` Cold (cache volume removed):
`./runtime/comply.sh --check-only --timings` → stderr
`defined: cache eslint hit=0 miss=77`, `defined: cache node hit=0 miss=115`,
`defined: timing no-fix pass 2859ms`; stdout `{"status":"compliant"}`.

`[FACT]` Warm (immediately after): `defined: cache node hit=115 miss=0`,
`defined: cache eslint hit=77 miss=0`, `defined: timing no-fix pass 1813ms`;
stdout unchanged.

`[INFERRED]` Warm saves ~1.0s on this repo's no-fix pass (~35%). The effect
scales with scope; the number is indicative, not a benchmark contract (image
pull and a busy host land in it too).

## Verification

`[FACT]` `node --test 'cli/*.test.mts' 'lib/*.test.mts' 'runtime/**/*.test.mts'`
→ **500 pass, 0 fail**.

`[FACT]` `./runtime/comply.sh` → `{"status":"compliant"}`.

New tests cover: hit/miss reuse, content edit invalidates one file, effective
config change invalidates all, added/deleted scope, cached-vs-uncached agreement
(both steps), consumer-config bypass, corrupt manifest tolerated, unwritable
flush swallowed, `partitionByHash`, metric gating, and the launcher volume.

## Traps for the next agent

`[FACT]` A recorded entry is invisible to `lookup` on the same instance:
`createFileCache` loads the manifest into memory at construction and `record`
only fills the in-run map, so a test that records then looks up must `flush()`
and reopen first. (The `partitionByHash` unit test failed on exactly this before
it was rewritten.)

`[FACT]` The gate's own eslint enforces cyclomatic complexity ≤ 10. The naive
in-step cache edits pushed `runNodeStep` to 20 and `runEslintStep` to 24 and the
gate failed; the fix was `partitionByHash` plus the `verifyNode` / `verifyEslint`
helper extraction. Budget for extraction when adding branches to a step.

`[FACT]` Cache metrics must not go in `notice`: for a passing or skipped step it
is not rendered, and only a failing step with no diagnostics surfaces it
(`runtime/lib/report.mts`).

`[RISK]` House v1 rules are file-local, which is what makes per-file reuse
sound. A future eslint rule that lints one file in the context of others (an
import graph, a project-wide budget) would make per-file caching unsound without
widening the unit or the identity.

`[INFERRED]` A consumer-owned config bypasses the cache entirely — correct by
construction until that config's own invalidation inputs (its plugins, its
imported shared config) are defined.
