<!-- update: agent=opencode | date=2026-09-26 | scope=practices/2026-09-26_workflow-and-tofu-fixes.md -->

# Plan — `workflow` actionlint scope and per-directory `tofu`

Two producer-side defects in the gate, found while adopting `defined` into
`rdd-astro` (Astro monorepo: OpenTofu module under `infrastructure/`). Both are
gate bugs, not consumer content. They keep the `workflow` and `tofu` steps from
telling the truth, so a consumer cannot reach a fully green `comply`.

Work them in order: **Fix 1 is small and high-confidence and should land as its
own commit** ahead of the heavier per-directory `tofu` rework.

## Evidence

Adopting repo result (`defined verify`): `naming`, `shell`, `yaml`, `node`
pass; `workflow` fails with

```text
workflow: actionlint failed: .github/dependabot.yml:1:1: "jobs" section is missing in workflow
```

The `tofu` step reports pass while never touching `infrastructure/*.tf` (no root
`.tf`, so it runs against an empty root directory).

---

## Fix 1 — actionlint must only receive `.github/workflows/*`

**File:** `runtime/steps/workflow.mts`

### Problem

`filterWorkflowFiles` (lines 47–55) returns workflows **plus**
`.github/dependabot.yml`, and that one list is handed to _both_ actionlint and
zizmor (lines 170–192). actionlint is workflow-only: handed `dependabot.yml` it
parses it as a workflow and false-fails every consumer that uses Dependabot.
Because actionlint runs first and returns on failure, this also masks zizmor's
real findings — they never get a chance to report.

The `naming` step already solved this exact split: `runtime/steps/naming.mts`
lines 56–63 carry their own `filterWorkflowFiles` that excludes `dependabot.yml`.
The workflow step should mirror it.

### Change

Keep `filterWorkflowFiles` as the _audit_ set (activation + zizmor). Add a
workflow-only filter for actionlint:

```ts
/** Workflow definitions actionlint may parse (never dependabot.yml). */
export function filterActionlintFiles({
    files,
}: {
    files: string[];
}): string[] {
    return files.filter(
        (file) =>
            file.startsWith(".github/workflows/") &&
            (file.endsWith(".yml") || file.endsWith(".yaml")),
    );
}
```

Split the single `if` in `runWorkflowStep` into two, actionlint first:

```ts
const workflowFiles = filterWorkflowFiles({ files: trackedFiles }); // activation + zizmor
const actionlintFiles = filterActionlintFiles({ files: trackedFiles });

if (actionlintFiles.length > 0) {
    const actionlint = runner({
        cmd: "actionlint",
        args: actionlintFiles,
        cwd: ctx.repoRoot,
    });
    if (actionlint.status !== 0) {
        return failed({
            notice: `workflow: actionlint failed: ${actionlint.stderr.trim() || actionlint.stdout.trim()}`,
        });
    }
}
if (workflowFiles.length > 0) {
    const zizmor = runner({
        cmd: "zizmor",
        args: ["--no-progress", ...workflowFiles],
        cwd: ctx.repoRoot,
    });
    if (zizmor.status !== 0) {
        return failed({
            notice: `workflow: zizmor failed: ${zizmor.stderr.trim() || zizmor.stdout.trim()}`,
        });
    }
}
```

gitleaks is untouched (always runs against the repo's git scope).

Update the comment header (lines 11–13): actionlint runs on workflow files only;
zizmor also audits `.github/dependabot.yml`.

Tighten the final success notice (lines 235–240) so a dependabot-only run does not
claim actionlint ran.

### Tests — `runtime/steps/workflow.test.mts`

- Keep the existing `filterWorkflowFiles ... and dependabot.yml` test (line 27),
  reworded as the _audit_ set.
- Add `filterActionlintFiles` unit test:
  `[".github/workflows/ci.yml", ".github/dependabot.yml", ".github/workflows/cd.yaml"]`
  → `[".github/workflows/ci.yml", ".github/workflows/cd.yaml"]`.
- **Regression test:** step run with both files tracked → actionlint call args
  are `[".github/workflows/ci.yml"]`; zizmor call args include
  `.github/dependabot.yml`.
- Dependabot-only tracked set → actionlint never invoked, zizmor invoked, step
  passes.

### Open decision — duplicate `filterWorkflowFiles`

`workflow.mts` and `naming.mts` now both export `filterWorkflowFiles` with
_different_ semantics — a genuine footgun. Either rename the workflow one to
`filterWorkflowAuditFiles`, or lift a shared `lib/workflow-files.mts` exporting
the workflow-only set and the audit set, imported by both steps. **Recommendation:
the shared lib** — it kills the divergence permanently.

**Resolved** — implemented as `runtime/lib/workflow-files.mts` (decision #42):
`filterWorkflowFiles` (workflow definitions) and `filterWorkflowAuditFiles`
(plus `dependabot.yml`).

---

## Fix 2 — tofu must run against the module directories, not the repo root

**File:** `runtime/steps/tofu.mts`

### Problem

Every phase runs with `cwd: ctx.repoRoot` (lines 66–133). In a monorepo whose
module lives in a subdirectory (no root `.tf`), `tofu fmt -check` finds nothing
and `init`/`validate` run against an empty root — `validate` reports success on
an empty directory, so the step is a **false green**. Nested `.tf` is never
formatted, linted or validated.

### Recommended shape

- **fmt:** one call at `repoRoot` with `-recursive` — covers every nested `.tf`,
  needs no provider, is idempotent. Fix mode `fmt -write -recursive` then
  re-check `fmt -check -recursive`.
- **tflint + init/validate:** per **root** directory. Discover directories
  containing tracked `.tf` files, normalise the repo root to `.`, then keep only
  the _top-most_ dirs (drop any dir that has a discovered ancestor) so a nested
  module is not validated once per parent. Run `tflint --init` (and `--fix` in
  fix mode), `tflint`, then `tofu init -backend=false`, `tofu validate` with
  `cwd: join(repoRoot, dir)`.
- Add an exported, unit-testable `tfDirectories({ files })` helper: sorted,
  deduped, top-most.
- **Config override:** add an optional `tofu` key to `.defined.json` —
  `{ "tofu": { "dirs": ["infrastructure"] } }` — validated in
  `runtime/lib/config.mts` (non-empty string array, repo-relative; absent =
  auto-discover). This is the escape hatch for ambiguous layouts and matches how
  `node`/`coverage` are config-driven.
- **Failure notices must name the directory:** `tofu: validate failed in
infrastructure/: <msg>` — otherwise a monorepo failure is unattributable.
- Keep the clean skip when no `.tf` is tracked.

### Tests — `runtime/steps/tofu.test.mts`

- `tfDirectories` unit: dedupe/sort; root `.` case; top-most selection —
  `["main.tf", "infrastructure/main.tf", "infrastructure/modules/vnet/main.tf"]`
  → `[".", "infrastructure"]` (nested module dropped).
- Step run with only `infrastructure/main.tf`: recorded `cwd`s are
  `<root>/infrastructure`; fmt carries `-recursive`.
- Fix mode formats each.
- Failure notice names the failing directory.
- Config `tofu.dirs` restricts the set.
- Existing "skips when no .tf" test is unchanged.

---

## zizmor — no gate fix, do not "solve" it in the gate

zizmor correctly audits `dependabot.yml` (that is where its
`dependabot-cooldown` findings come from), and its default severity
(informational, every finding fails) is decision #23 — intended. Keep feeding it
the combined audit set.

Once Fix 1 lands, consumer gates will surface genuine zizmor findings
(`unpinned-uses`, `excessive-permissions`, dependabot cooldown). Those are
**consumer content** to fix in the consumer repo, not a reason to narrow zizmor
here. State this in the PR so nobody "fixes" it by lowering severity.

---

## Process and release

- Update **`PLAN.md`**: record both defects with decision numbers (next free
  after #40 — likely #41 for the actionlint/zizmor split, #42 for per-directory
  tofu) and reflect them under "Open gaps" / "Recently delivered" as
  appropriate. The plan is the entry point for a fresh session.
- Run the gate's own suite (`node --test`) and the podman end-to-end
  (`./runtime/comply.sh`). Note the producer repo commits a versionless
  coverage-only `.defined.json` and has no `.tf`, so `tofu` skips there — test
  the per-directory path with a fixture, not the producer repo.
- On merge to `main`, `defined--publish.yml` publishes the image; then in the
  consumer run `defined update latest` (writes the new pin) and commit. The
  installed `defined--verify.yml` compares the pinned image, so the repin is what
  flips the consumer's `workflow` step green.

## Status

- [x] Fix 1 — actionlint file scope (`lib/workflow-files.mts` + `steps/workflow.mts` + tests)
- [x] Shared workflow-files helper (settled as the shared lib)
- [x] Fix 2 — per-directory tofu (`steps/tofu.mts` + `lib/config.mts` + tests)
- [x] `PLAN.md` decisions and gaps updated
- [ ] Publish image, repin consumer

Recorded as decisions **#42** (actionlint/zizmor view split) and **#43**
(per-directory tofu + no-fix scratch).

## Implementation notes

- Fix 1 landed as `runtime/lib/workflow-files.mts`: `filterWorkflowFiles`
  (workflow definitions — naming + actionlint) and `filterWorkflowAuditFiles`
  (plus `dependabot.yml` — zizmor). The duplicated, naming-divergent filters are
  gone; the open decision is settled in favour of the shared lib.
- Fix 2 deviations, both deliberate:
    - fmt is scoped to the **tracked `.tf` files**, not `fmt -recursive` at the
      root: a recursive walk descends into gitignored `.terraform/modules`
      copies, breaking the gate's "scope = git scope" invariant.
    - The top-most rule treats `.` specially: a deeper dir is dropped only when it
      has a discovered ancestor _other than_ `.`, so a root module and a nested
      module are both validated (the sketch's "drop any dir with a discovered
      ancestor" contradicted its own test).
- Also fixed in review: `tofu` was the only write-capable step without a
  scratch. `init` writes `.terraform/` + a lock file, which a read-only
  verify/CI mount cannot host, so it now runs in the shared `/tmp` scratch via
  `resolveWorkingRoot` (wired through `comply.mts`), matching node/dotnet.
