---
Area: decisions
Keywords: scan, install-less, read-only, bootstrap, agents block, adoption, work repos, ignored .defined.json, launcher cache
Summary: A third result verb, `scan`, runs the gate's lint/scan steps read-only with the bootstrap check skipped, so a repo can be tried without adopting it; `cli/scan.sh` caches the launcher for an install-less one-liner.
---

# Decision — `scan`: the install-less, non-adopting gate run

## Facts

- `comply` writes adoption artefacts: seeded defaults (`.editorconfig`,
  `.gitattributes`, `Directory.Build.props` when .NET files are tracked), the
  managed workflow, the AGENTS.md block and a pinned `.defined.json`.
- `verify` never writes, but its bootstrap check **fails** on an unadopted
  repo (missing managed workflow and AGENTS block), so it cannot be used as a
  try-out on a repo you do not own.
- `scan` is the verify flow with `checkSetup` skipped. It reports
  `results.bootstrap: "skip"`, emits no bootstrap errors, never takes the
  comply lock, mounts the repo read-only, and runs the identical no-fix pass
  (scratch copies for write-capable steps). The single JSON result line,
  `--min`/`--full`/`--timings` and the exit contract are unchanged. (Amended by
  [scope-and-workspaces](scope-and-workspaces.md): `scan` now reports `config`
  notices, so a narrowed content scope is visible where a work repo runs it.)
- `scan` also accepts `--files <paths…>`: the named files replace
  `scope.include` for the seven content steps, a path outside the git inventory
  is a usage error, and the report names the steps that still judge the whole
  repository. The exit code keeps its whole-repository meaning (see the
  [scope-and-workspaces](scope-and-workspaces.md) addendum).
- Consumer commands stay declarations-only: `node.checks`,
  `coverage.*.command` and `naming.command` run only when `.defined.json`
  declares them. With no config those steps report `skip`. There is no
  `--test` argv flag and no guessing (the gate already refuses to infer
  equivalence from command text for `satisfies`, because similar commands can
  cover different suites).
- Config is read from the mounted repo root (`loadConfig({ repoRoot })`), not
  from the git scope, so a **gitignored `.defined.json` is honoured**. That is
  the work-repo path: keep the config in `.git/info/exclude`, run `scan`, and
  nothing gate-related enters the committed tree. Caveats: CI never sees an
  ignored config, and declared commands run against the scratch copy of the git
  scope, so gitignored fixtures/`.env` files are absent there — identical to
  `verify`.
- `cli/scan.sh` is the install-less entry point. It downloads `cli/defined`
  from published `main`, verifies an embedded `LAUNCHER_SHA256` (the same
  matched-pair pattern as `cli/install.sh`), caches it at
  `${XDG_CACHE_HOME:-$HOME/.cache}/defined/launcher-<hash12>`, then execs
  `scan`. Content-keyed naming means a newer script never trusts an older
  cached launcher; `--refresh` forces a re-fetch. Only `--refresh`/`--help` are
  the script's own; every other argument is forwarded to the gate.

## Inferred

- A flag (`comply --scan`) was rejected: the established contract is that
  flags change presentation only, never scope, so a scope change must be a
  verb.
- A required or guessed test command was rejected for three reasons: it would
  create a second, uncommitted home for commands (invisible to CI); it would
  execute arbitrary argv in repos the operator does not own; and guesses are
  unsound across ecosystems and monorepos.
- The verb is safe to add without a lock: the no-fix pass already never writes
  to the checkout (proven by the fixture hashTree assertions), so two scans
  cannot race the tree.

## Tested

- Unit: `scan` parses with the same presentation surface; the scan flow never
  calls `checkSetupFn`, reports `bootstrap: skip`, runs one no-fix pass and
  exits 1 on a failing step.
- Launcher: `scan` mounts `/repo:ro`, keeps the content-cache volume, and is
  forwarded verbatim; the source-repo shim receives `scan`.
- `cli/scan.sh`: cold download and cache, warm reuse without a fetch,
  `--refresh`, checksum-mismatch refusal (nothing cached, no engine run), help,
  `XDG_CACHE_HOME` fallback, and the embedded-checksum pair guard.
- E2E (real gate in-container): the broken fixture scanned — every broken
  ecosystem reported, `bootstrap` skipped, no bootstrap errors,
  `node-checks`/`node-coverage` skipped, **no artefact created** and the tree
  byte-identical; the clean fixture scanned — `compliant`, untouched; a clean
  fixture with a gitignored `.defined.json` declaring one check — the check
  runs (`node-checks: pass`), tree untouched.

## Open questions

- **Global distribution.** npm is a possible future convenience (a package
  shipping the launcher as a bin), but that is an installation, not the
  install-less path; it needs its own decision and a launcher-revision story.
- **Cached-launcher freshness.** Content-keyed cache entries make staleness
  harmless and `--refresh` covers a deliberate bump; no TTL is imposed.
- **Scan on adopted repos.** `scan` equals an adopted repo's `verify` minus the
  bootstrap check; whether teams want scan in CI (where `verify` is the
  contract) is left to the consumer.
