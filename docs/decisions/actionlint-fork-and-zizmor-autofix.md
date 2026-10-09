---
Area: decisions
Keywords: actionlint, zizmor, self-repository, autofix, toolchain conflict, reusable workflow, rdd-astro
Summary: The zizmor 1.30.1 `self-repository` audit across 24 reusable-workflow calls, and the toolchain conflict that made its autofix unsafe in `comply`.
---

# Plan — actionlint upstream, and zizmor autofix in `comply`

Found while adopting the gate into `rdd-astro` (Astro monorepo). Repinning to a
gate build carrying **zizmor 1.30.1** surfaced a new audit — `self-repository`
(added in zizmor v1.30.0) — across 24 in-repo reusable-workflow calls. Chasing
the autofix exposed a toolchain conflict, which is the real subject of this
record.

## Evidence

`defined verify` in rdd-astro after the repin: `workflow` is the only red step —

```text
help[self-repository]: use GitHub's dedicated self-repository syntax
  --> .github/workflows/dev--deploy.yml:24:15
   |
24 |         uses: ./.github/workflows/frontend--build.yml
   |               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ use '$/...' instead of './...'
```

24 findings, all that audit, across `release--deploy.yml` (10),
`dev--deploy.yml` (4), `repo--verify.yml` (4), `infra--destroy--manual.yml` (3),
`pull-request--verify.yml` (3). Nothing else fails.

zizmor's autofix for the audit is **unsafe-only** (`--fix` changes nothing;
`--fix=all` rewrites all 24). But the rewrite is rejected by the gate's own
**actionlint 1.7.12**:

```text
reusable workflow call "$/.github/workflows/frontend--build.yml" at "uses" is not
following the format "owner/repo/path@ref" nor "./path/to/workflow.yml"
```

`$/` shipped on github.com in July 2026; actionlint's newest **release** is
1.7.12 (2026-03-30) and its maintainer has been inactive since ~April
([rhysd/actionlint#719](https://github.com/rhysd/actionlint/issues/719)).
Support is an open, unreleased PR
([#732](https://github.com/rhysd/actionlint/pull/732), issue
[#711](https://github.com/rhysd/actionlint/issues/711)).

So blanket unsafe autofix would trade a zizmor _low_ finding for an actionlint
_hard failure_ — a mutated working tree, still red. That is the decisive
evidence behind the safe-only decision below.

---

## Decision 1 — actionlint moves to the maintained fork

**Files:** `runtime/tool-versions.env`, `runtime/Containerfile`

Upstream `rhysd/actionlint` is dormant and its `uses:` grammar is months behind
GitHub: no `$/`, no parallel steps (GitHub, June 2026), drifting runner labels,
action metadata and permission scopes. The maintained fork
[`kjanat/actionlint`](https://github.com/kjanat/actionlint) is a **drop-in CLI
replacement** — same flags, output, config and file formats — with `$/` support
ported. Version bumped 1.7.12 → **1.17.0**; the Containerfile URL changes
`rhysd` → `kjanat`. The release asset naming and tar layout are identical, so
the `actionlint --version` assertion is unchanged.

This is upstream _selection_, not forking the floor: the CLI is a drop-in and
the module-path change only affects library consumers, which the gate is not.

Verified: the fork binary accepts the converted copy (`actionlint.kjanat.dev
1.17.0`, exit 0), and the rebuilt gate image carries it.

---

## Decision 2 — zizmor safe autofixes run in `comply`'s repair pass

**Files:** `runtime/steps/workflow.mts`, `runtime/lib/workflow-files.mts`,
`runtime/setup.mts`

In fix mode, `zizmor --fix` runs **first**, its output and exit status
discarded; the existing actionlint → zizmor → gitleaks sequence then judges the
result. Same shape as `shfmt -w` / `prettier --write`: a fix that leaves
breakage can never read as success.

- **Safe fixes only.** Unsafe fixes are deliberately never applied — they encode
  design decisions (persist-credentials, cache disabling, dependabot
  deny-execution), and today `self-repository` is the proof that "unsafe" can
  mean "not yet validatable".
- **The gate-managed workflow is excluded** from the fixer's file list
  (`filterFixableFiles`, minus `MANAGED_WORKFLOW_FILE`). The managed file is
  gate-owned and repaired upstream; a consumer-side autofix must never rewrite
  it. That constant is now the single source of truth, shared with
  `setup.mts`'s install target.
- `actionlint` and `gitleaks` stay check-only.

---

## Follow-ups (not this change)

- **zizmor runs offline and token-less in the gate.** Its own warning says it:
  _"some audits and auto-fixes will not be available."_ `unpinned-uses` pin
  verification, `impostor-commit`, `archived-uses`, `known-vulnerable-actions`,
  `stale-action-refs` and `ref-confusion` need the API. Passing `GITHUB_TOKEN`
  in the managed CI workflow would turn them on. (An online run locally also hit
  a zizmor crash in `stale-action-refs`, so this needs care.)
- **Persona is `regular`**, which hides medium-confidence `excessive-permissions`
  and pedantic `undocumented-permissions`/`concurrency-limits` — 25 suppressed
  findings on rdd-astro, 11 of them medium. Deliberate signal/noise, but an
  inherited default rather than a recorded decision.
- **The actionlint download carries no checksum** (true before and after this
  change) — the only tool fetched without one.
- **rdd-astro still has to adopt `$/`** (a deliberate semantic change, so not
  something safe-only autofix does for it), after the fork image is published
  and repinned.

## Consumer rollout

1. Merge → `defined--publish.yml` publishes pinhash + shortsha tags.
2. In rdd-astro: `defined update latest`, convert `./` → `$/` across the five
   workflows, commit, `defined comply` green.

## Status

- [x] Decision 1 — actionlint fork (pin + Containerfile) — `runtime/tool-versions.env`, `runtime/Containerfile`
- [x] Decision 2 — safe-only zizmor autofix — `steps/workflow.mts`, `lib/workflow-files.mts`, `setup.mts`
- [x] Tests — `steps/workflow.test.mts` (fix ordering, status-ignored, re-check verdict, managed exclusion, dependabot-only)
- [x] Gate green: `node --test` (317) and `./runtime/comply.sh`
- [ ] Publish image, repin rdd-astro, adopt `$/`
