---
Area: plans
Date: 2026-10-04
Keywords: explain, node-coverage, dotnet-coverage, lcov, cobertura, coverage path, docRel, standards doc, tofu fixture, provider-free, terraform_data, tflint required_providers, flake, PR 88, PR 90, issue 89
---

# Explain coverage-path doc (and the provider-free tofu fixture)

Why `defined explain node-coverage` returned no doc, the change that gave it one
(commit `5b5b005`), and the unrelated container-e2e flake that blocked its
re-land — now fixed (#89/#90). Tag policy:
`~/.config/opencode/EVIDENCE-TAGS.md` — not restated here.

## Coverage report paths (the finding)

`[FACT]` the gate reads coverage reports from fixed paths, not configurable:
`runtime/steps/node-coverage.mts` sets `LCOV_PATH = "coverage/lcov.info"` and
reads `join(workingRoot, LCOV_PATH)`; `runtime/steps/dotnet-coverage.mts` sets
`COBERTURA_NAME = "coverage.cobertura.xml"` with a second candidate
`TestResults/coverage.cobertura.xml`. `runtime/lib/config.mts` `CoverageConfig`
exposes only `command`, `minimums` and `satisfies` — there is no report-path
knob.

`[FACT]` `.defined.json` `coverage.<eco>.minimums` defaults to 80% line when the
key is absent entirely (`effectiveMinimums` in both coverage steps).

`[FACT]` before `5b5b005`, `defined explain node-coverage` and
`defined explain dotnet-coverage` returned `"doc":null` with a notice pointing at
the README. `defined explain` serves only `standards/` docs
(`runtime/lib/explain.mts` `docRel`), so the answer was not in place even though
the README coverage section documents the paths.

## The change (`5b5b005`)

- `standards/coverage.md` (new): fixed report paths, consumer-owned
  `command`/`minimums`/`satisfies`, the 80% line default, the gate as the single
  threshold authority, and verify-vs-comply scratch behaviour. Runnable examples
  stay in the README (single home of `.defined.json` examples).
- `runtime/lib/explain.mts`: `docRel: "coverage.md"` on both coverage steps plus
  a path-naming notice; the `Explanation.notice` comment updated (a doc-bearing
  topic may now also carry one).
- `runtime/lib/explain.test.mts`: doc-routing and notice-path tests per step.
- `[FACT]` verified before PR #88: `node --test` → 447 pass; live
  `defined explain node-coverage` returns `doc` + `guidance`;
  `./runtime/comply.sh` → compliant.

## The tofu fixture flake (why PR #88 was closed)

`[FACT]` `runtime/lib/fixture.mts` declared `hashicorp/null` in the fixture
`main.tf` (`required_providers`) so tflint's default `terraform_required_providers`
rule stayed green. The gate's tofu step runs `tofu init -backend=false`
(`runtime/steps/tofu.mts`), which still fetches providers, so the e2e performed a
github.com provider download.

`[FACT]` on PR #88 that download failed after 3 attempts (`hashicorp/null
v3.3.2`, `Defined Tests` run 37156515026), failing `check-only and comply are
both green after semantic repair` — unrelated to the diff. PR #88 was closed
unmerged; branch `add-coverage-doc` preserved.

## The fix (#89, PR #90, commit `98f767a`)

`[FACT]` the fixture is now provider-free: core-only `terraform_data` and no
`required_providers` block, keeping the same fmt drift the tofu step repairs.
Gate tofu `fmt`/`tflint`/`init`/`validate` stay exercised end to end; only the
provider-install path drops out.

`[FACT]` an absent `required_providers` block is tflint-clean — the issue's
stated constraint ("tflint flags an absent block") is wrong for this pin.
Verified in the gate image (tflint 0.64.0, tofu 1.12.6) with `--network=none`:

```
=== A tflint (no required_providers) ===      -> exit 0
=== A tofu init -backend=false (network OFF) === -> exit 0
=== A tofu validate ===                        -> Success! The configuration is
                                                  valid. (exit 0)
=== B tflint (empty required_providers) ===     -> exit 0 (also clean, but
                                                  unnecessary)
```

The rule (`tflint-ruleset-terraform/rules/terraform_required_providers.go`)
iterates `runner.GetProviderRefs()` and only warns for referenced providers; a
core-only config references none, so no block is needed.

`[FACT]` `runtime/fixture.test.mts` gained a deterministic, engine-free guard
asserting the fixture `main.tf` declares no provider / provider-backed resource,
so a reintroduced provider fails fast instead of flaking on egress.

`[FACT]` verified on the #90 branch: `node --test runtime/fixture.test.mts` → 3
pass (both container e2e runs exercised `tofu init` provider-free);
`./runtime/comply.sh` → `{"status":"compliant"}`; `node --test` → 444 pass. The
PR was green on checks and the SonarCloud gate `OK`.

## Traps

- `[FACT]` a `Defined Gate` workflow run on a `main` push concludes `skipped`
  (its job guard excludes `markstanden/defined`; `Defined Tests` covers it), so
  the pr-flow `post-merge` verdict reads `red`. That skip is expected noise, not
  a failure.
- `[FACT]` recreating `docs/plans/explain-coverage-doc.md` after the #90 merge
  reproduced the merge-time loss: the doc is now tracked, but a branch cut from
  before the commit and rebased on `main` can drop it in a later merge (see
  Corrections).

## Corrections

- This doc lived on branch `add-coverage-doc` as commit `c62c288` and was lost
  from `main` when the #90 squash merge was made from a branch cut before it.
  Recreated (same path, this content) in the docs/ commit of this findings
  session.
- The project brief's "Open problem" claimed the docblock-floor branch was
  review-green pending push/PR. It merged as #87 (`a280040`); the coverage doc is
  now the open item and #89/#90 is closed.
- The `plans/explain-coverage-doc` index card likewise lived only on
  `add-coverage-doc` and is re-added here.

## Open work

- `[NOT TESTED]` #89/#90 confirms provider-free tofu init in the e2e, but a
  consumer repo whose own `.tf` declares providers still needs registry egress
  at gate run time — that is inherent, not a fixture concern.
- `[NEEDS DECISION]` re-land the coverage doc: decided to open a **fresh PR**
  from the rebased `add-coverage-doc` (PR #88 stays closed). Then delete
  `docs/plans/PLAN_add-coverage-doc.md`.

## Context

- `runtime/lib/explain.mts` — step→doc mapping (`docRel`).
- `runtime/steps/node-coverage.mts`, `runtime/steps/dotnet-coverage.mts` — paths.
- `runtime/lib/fixture.mts`, `runtime/steps/tofu.mts` — the flake and its fix.
- `standards/coverage.md` — the doc added on the re-land branch.
- PRs #90 (merged) and #88 (closed), issue #89, commit `5b5b005`.
