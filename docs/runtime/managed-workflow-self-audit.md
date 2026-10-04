---
Area: runtime
Date: 2026-10-04
Keywords: managed workflow, defined--verify.yml, workflow.disable, self-host, dogfood, actionlint, zizmor, gitleaks, checkSetup, skipped, pr-flow, post-merge
---

# Why this repo keeps its managed workflow

Claims are tagged per `~/.config/opencode/EVIDENCE-TAGS.md`.

This repo installs `.github/workflows/defined--verify.yml` even though its gate
steps are skipped on `markstanden/defined` (a host-repo validation step runs
instead). The question that prompted this note: since `workflow.disable` now
exists, should this repo switch it on and `git rm` the copy to keep the Actions
tab clean? Short answer: no — the copy is the self-audit vehicle for the one
workflow every consumer runs.

## The guard

`[FACT]` Each gate step in `.github/workflows/defined--verify.yml` carries
`if: github.repository != 'markstanden/defined'`; on this repo those steps are
skipped and a single `Host repo — managed workflow live validation` step runs
instead, so the job concludes `success`. An earlier revision guarded the whole
job, which made the run conclude `skipped` (observed in the post-merge rollup
for merge `77a97be`: `Defined Gate #37183205750:completed/skipped`).

`[FACT]` `AGENTS.md` records the reason: the published image would compare its
baked standards against a working tree mid-change, so any PR touching a managed
file would false-fail on drift until release. This repo is covered by
`.github/workflows/defined--test.yml` instead.

## What the installed copy earns its keep on

`[FACT]` `workflow.disable` stops the gate installing and checking the managed
workflow. It is documented for hosts that **cannot** run it (Azure DevOps,
GitLab, a private server) — `runtime/lib/config.mts:124`-`130`, `README.md:316`-`326`.
It is not a "quiet the skipped run" knob.

`[FACT]` On every self-host `verify`, `checkSetup` byte-compares each managed
file (the workflow included) against the baked source via `checkManagedFiles` —
`runtime/setup.mts:214`-`233`. `bootstrapFiles` drops the workflow from that set
when disabled (`runtime/setup.mts:93`-`95`), so disabling also drops the parity
check.

`[FACT]` The `workflow` step actionlints `filterWorkflowFiles`
(`.github/workflows/*.yml`) and zizmors `filterWorkflowAuditFiles` (the same plus
`.github/dependabot.yml`) — `runtime/steps/workflow.mts:190`-`230`,
`runtime/lib/workflow-files.mts:21`-`41`. The source of truth,
`standards/workflows/defined--verify.yml`, sits **outside** that glob.

`[INFERRED]` Therefore deleting the installed copy and disabling would remove the
only actionlint/zizmor/gitleaks coverage of the managed workflow's content, plus
the byte-parity self-check. The gap: this was reasoned from the file globs, not
proven by deleting the copy and re-running the gate.

## Recommendation

`[INFERRED]` Keep the installed copy. The host-repo job is one no-op step; the
copy is dogfood, audit and parity for the artifact every consumer runs.

`[INFERRED]` If a clean Actions tab is wanted later, the principled order is to
add `standards/workflows/defined--verify.yml` to the `workflow` step's audit set
**first**, then `workflow.disable` + `git rm` the installed copy. Removing without
relocating the audit trades a visible no-op for an invisible loss.

`[NEEDS INVESTIGATION]` Is relocating the audit worth it, and how does the naming
step's workflow grammar interact with a `standards/workflows/` path it does not
currently see? Blocked on: a decision to pursue a clean CI surface at all.

## Trap: `pr-flow` post-merge false positive

`[FACT]` The `pr-flow` skill's `pr-prep.sh post-merge` reported `state: "red"` for
merge `77a97be` solely because `Defined Gate` concluded `skipped`; the two real
runs (`Defined Tests`, `Publish Defined Image`) were queued/successful. The
post-merge verdict scale counts `skipped` as a failing conclusion.

`[INFERRED]` For this repo that verdict was always a false positive — the skip
was by design. Two fixes were open: treat `skipped` as neutral in the verdict
scale, or expect and ignore it here.

`[FACT]` Resolved at source instead: the job now runs the host-repo validation
step and skips the gate steps individually, so the run concludes `success` and
the false positive cannot recur. A `skipped` run still proves GitHub accepted the
workflow file — an invalid one concludes `startup_failure`, not `skipped` — but a
green run states it plainly.

`[INFERRED]` The `pr-prep` scale still counts `skipped` as failing, so any other
workflow that legitimately skips on a push will still read red; that is a
`pr-prep` concern, not this repo's.
