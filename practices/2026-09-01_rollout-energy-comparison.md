<!-- update: agent=opencode | date=2026-09-26 | scope=practices/2026-09-01_rollout-energy-comparison.md -->

# Rollout — first consumer adoption: energy-comparison

Working log of the first real rollout of the `defined` gate into a consumer
repo (`markstanden/energy-comparison`, cloned from the `csharp-template`,
pristine single commit, dotnet 10). Purpose: **validate the product**, record
friction, feed fixes back into `defined`, and align the template afterwards.

## Findings so far

1. **The installed launcher drifts.** The one-time install
   (`install -m 755 cli/defined ~/.local/bin/defined`) predates the current
   `.defined.json` API — the stale copy demanded a `.defined-version` file and
   refused to run. No self-update; a consumer following the README once, long
   ago, silently runs an old launcher. Manual reinstall fixed it. Worth
   considering: launcher version check against the pinned image, or a
   `defined upgrade` verb. **Resolved** — the launcher now carries a lifecycle
   surface: `defined version` reports launcher/pin/image/engine drift (read-only,
   degrades to "unknown" offline) and `defined update [<sha>|latest]` moves the
   launcher, pin and image together, so a stale install self-heals instead of
   demanding a manual reinstall.

2. **Bootstrap refuses to adopt over differing managed files.** The gate's
   contract (by design) is byte-identical-or-fail: a differing `.editorconfig`
   or `Directory.Build.props` hard-fails `comply` with "resolve by hand, the
   gate never overwrites or merges". The template ships its own (richer,
   different) versions of both, so the first `comply` was blocked. Adoption
   into any repo that already has these files is a conscious decision to adopt
   the standards floor verbatim. This is the raises-only contract in action,
   but it deserves a documented adoption note. **Superseded** — the shared
   config files (`.editorconfig`, `Directory.Build.props`, `.gitattributes`) are
   now _seeded defaults_: installed only when absent, never overwritten and
   never gated. A repo with its own copies keeps them, so the first `comply` is
   no longer blocked. Only the gate workflow is a byte-identical managed file.

3. **The template is not aligned with standards.** `csharp-template`'s
   `.editorconfig` (88 lines vs standards' 200) and `Directory.Build.props`
   differ substantially. Critically, the template's props carries
   `TargetFramework=net10.0` (and `ImplicitUsings`) that the empty
   `src/...Core.csproj` depends on — adopting the standards props (no TF)
   breaks the build unless TF moves into the csproj. The template must be
   re-aligned to standards before it can be a gate-ready starting point
   (Phase 3). **Open — external (Phase 3).** The only rollout item still
   outstanding: aligning `csharp-template` to the standards floor is a change in
   that repo, not the gate. Note the adoption _blocker_ is gone (seeded defaults
   keep the template's own richer props), so this is now a tidy-up rather than a
   prerequisite.

4. **The tightening layer is undocumented.** The template's stricter settings
   (`TreatWarningsAsErrors`, `Deterministic`) cannot live in the managed
   `Directory.Build.props` (byte-identical or fail). The unmanaged
   `Directory.Build.targets` is the natural "tighten here" layer. The
   raises-only story ("projects may tighten the floor") needs this mechanism
   documented. **Documented, premise updated** — `Directory.Build.props` is now
   a _seeded default_, not a managed file (only the gate workflow stays
   byte-identical), so a repo owns its props once installed. The README's
   "Tighten the floor; don't fork it" note directs project-specific tightening
   into an unmanaged `Directory.Build.targets` so the house baseline stays
   recognisable and the deltas stay diffable.

5. **XML-declared coverage gates vs CLI-declared.** The template enforced a
   **100% branch** gate via coverlet XML thresholds in the test csproj
   (`Threshold=100`, `ThresholdType=branch`). The defined gate declares
   minimums in `.defined.json` (CLI-declared — Mark's preference). Resolution:
   drop the XML thresholds, keep `coverlet.msbuild` purely as report generator
   (it already emits `TestResults/coverage.cobertura.xml`, one of the gate's
   fixed paths), and enforce minimums via `.defined.json`. No XPlat staging
   hack needed here.

6. **Coverage report path — context.** The "staging wrinkle" only bites when a
   project has no coverlet and uses the SDK's XPlat collector, which writes to
   `TestResults/<guid>/coverage.cobertura.xml` — not a gate fixed path. For a
   coverlet-based dotnet project the gate reads `TestResults/coverage.cobertura.xml`
   directly. Documenting a canonical dotnet example per project type is still
   worth doing. **Documented** — the README coverage section now carries a
   node (built-in lcov reporter) and a dotnet (coverlet + `find` staging)
   example, notes the XPlat GUID-subfolder caveat, and states that minimums are
   declared only in `.defined.json` — never duplicated in XML thresholds.

7. **Standards props is not CPM-compatible.** `standards/Directory.Build.props`
   hard-codes `Microsoft.SourceLink.GitHub` with an inline `Version="1.1.1"`.
   Central Package Management forbids inline versions on `PackageReference`
   (NU1008), so any CPM-based consumer adopting the floor verbatim fails
   restore. **Resolved by modernising**: the .NET 10 SDK ships SourceLink
   built-in (`Microsoft.NET.Sdk.SourceLink.props/targets` + bundled
   `Microsoft.SourceLink.GitHub`/`Common` SDK sub-packages; an explicit package
   reference even _suppresses_ the built-in via `SuppressImplicitGitSourceLink`).
   The legacy PackageReference was removed from the standards props (both
   copies); `PublishRepositoryUrl`/`EmbedUntrackedSources`/`IncludeSymbols`
   keep working through the built-in machinery — the energy-comparison build
   emits `obj/.../sourcelink.json` with no package reference at all. The
   consumer's `PackageReference Remove` workaround is now dead weight to drop
   on repin.

8. **The gate caught the un-initialised template.** With standards' `AnalysisMode
All` (plus the consumer's `TreatWarningsAsErrors` tightening), the template's
   `__dotnet_template__` placeholder names failed CA1707 as build errors — the
   gate enforces "you forgot to initialise the template". Resolved by running the
   template's own `scripts/dev-setup.sh EnergyComparison` (the canonical
   renamer, works well). Not a bug; good signal.

9. **xUnit underscore test names vs the floor.** `AnalysisMode All` +
   `TreatWarningsAsErrors` turns CA1707 (underscores in identifiers) into a
   build error for idiomatic xUnit `Method_State_Expected` test names. First
   resolved with a nested `tests/<proj>/.editorconfig` scoping CA1707 (and
   CA1515 — xUnit discovers only public test classes) off for test code.
   **Upstreamed into standards**: the managed `.editorconfig` now carries a
   `[tests/**/*.cs]` policy relaxing CA1707/CA1515 for test projects under
   `tests/` (convention), so consumers need no nested file. Production code
   keeps the strict floor and InternalsVisibleTo stays the supported pattern
   for testing internals.

10. **THE critical one: the dotnet step is not read-only-verify safe — resolved
    with a no-fix scratch workspace.** The `dotnet` step runs
    `restore`/`build`/`test`, which write `obj/`+`bin/` into the repo. Both
    `defined verify` and the CI reusable workflow mount the repo **read-only**
    (`/repo:ro`), so a dotnet consumer's `verify` failed ("dotnet: build
    failed") — first real dotnet consumer breaks it. **Resolution:** `dotnet`
    and `dotnet-coverage` run against a **scratch copy of the repo's git scope
    under `/tmp`** (`runtime/lib/scratch.mts`), created only when dotnet
    activates and shared between the two steps. Fix mode still builds in the
    repo; no-fix (verify/CI) builds in scratch — MSBuild output relocation
    hacks rejected (no `$(MSBuildProjectName)` expansion in `-p:` globals,
    per-phase knobs). `dotnet-coverage` no-fix now runs the consumer's command
    in scratch and validates the scratch report — a committed/staged report is
    never required, so CI measures deterministically. **Proven end-to-end**:
    an ro-mounted `verify` against a throwaway dotnet repo is `compliant` and
    leaves the checkout byte-clean (no `bin/`/`obj/`, git unchanged). The
    gate's own repo stays self-host green (no dotnet → scratch never created).
    Requires image republish + repin before energy-comparison CI can go green.

11. **Prettier flags gitignored build artifacts — resolved with "gate scope =
    git scope".** `prettier --check .` walks the whole tree and prettier does
    not honour `.gitignore`, so gitignored `bin/`/`obj/` JSON files failed the
    node step after any local build. Instead of per-tool ignore patching (a
    prettierignore build-dir entry, then gitleaks, then the next tool), the
    gate now derives scope from git — the same scope every step already used:
    - **node/prettier** runs over the gate's tracked list
      (`git ls-files -co --exclude-standard` — tracked + untracked-not-ignored)
      filtered to prettier-parseable extensions, never `.`. Gitignored build
      dirs are absent by construction. The travelling prettierignore keeps only
      committed-but-not-for-prettier files (lockfiles, toml, properties); a
      consumer `.prettierignore` stays additive for the rare committed-but-
      exempt case.
    - **workflow/gitleaks** gets a generated config: default rules
      (`[extend] useDefault`) + an `[allowlist]` of exactly the repo's
      git-ignored paths (`git status --porcelain --ignored`), anchored regexes
      in TOML literal strings so an ignored `.env` never bleeds onto a tracked
      `.env.example`. Verified empirically: a real key in a gitignored `.env`
      no longer fails the gate, while a real key in any tracked file still
      does. Empty ignored set → no `[allowlist]` section (gitleaks rejects
      `paths = []`).
    - Rationale is determinism as much as noise: a gitignored local `.env`
      exists locally but never in CI, so whole-tree scans make **local red /
      CI green** — the exact inversion of the "no red X surprises" invariant.
      The gate judges the repo's git content, consistently, in both places.
    - Enabler: `comply` re-fetches the tracked file list _after_ bootstrap,
      because setup itself writes `.defined.json` + `AGENTS.md` — files a
      pre-bootstrap snapshot cannot contain (the old whole-tree walk saw them
      at runtime; a file-list snapshot would not).

## Disposition (2026-09-26)

Status of each finding against the current plan of record (`PLAN.md`):

| #   | Finding                                   | Status                                                         |
| --- | ----------------------------------------- | -------------------------------------------------------------- |
| 1   | Installed launcher drifts                 | **Resolved** — `defined version` / `defined update` (PLAN #35) |
| 2   | Bootstrap refuses differing managed files | **Superseded** — shared config is now seeded, not managed      |
| 3   | Template not aligned to standards         | **Open** — external (Phase 3), no longer a blocker             |
| 4   | Tightening layer undocumented             | **Documented** — README "Tighten the floor; don't fork it"     |
| 5   | XML vs CLI coverage gates                 | Resolved — minimums live only in `.defined.json`               |
| 6   | Dotnet coverage path example              | **Documented** — README coverage examples                      |
| 7   | Standards props not CPM-compatible        | Resolved — built-in SourceLink, no package ref                 |
| 8   | Gate caught un-initialised template       | Resolved — template renamer run; signal is correct             |
| 9   | xUnit names vs the floor                  | Resolved — `[tests/**/*.cs]` policy upstreamed                 |
| 10  | dotnet step not read-only-verify safe     | Resolved — no-fix scratch workspace                            |
| 11  | Prettier flags gitignored artifacts       | Resolved — gate scope = git scope                              |

Items 1, 2, 4 and 6 were the residual documentation/behaviour gaps; they are
now closed or recorded as delivered. Item 3 is the sole remaining rollout
action and lives in another repo.

## Actions in the consumer repo

- Adopted standards' `.editorconfig` + `Directory.Build.props` byte-identical.
- Moved `TargetFramework=net10.0` + `ImplicitUsings=enable` into the Core csproj.
- Moved `TreatWarningsAsErrors` + `Deterministic` into the unmanaged
  `Directory.Build.targets` (the tightening layer).
- Removed coverlet XML thresholds from the test csproj; kept coverlet for
  report generation.
- `.defined.json`: pin `664c6ce90cc9`, `coverage.dotnet` command `dotnet test`,
  minimums `{ line: 90, branch: 90 }` (CLI-declared, preserves a strong bar).
- Swapped CI to `defined--verify.yml@<full-sha>` (the template's hand-rolled
  `verify.yml` retired). Locally green via the gate (new scope changes
  validated against this repo with the live source).
- **Pending on image republish + repin** (defined changes land on main → publish
  → new shortsha): update `.defined.json` `version` and the workflow ref to the
  new SHA; re-adopt the updated managed files (the standards props lost its
  SourceLink pin, so the consumer copy must follow byte-identical); drop the
  now-redundant consumer `.prettierignore`; and remove the
  `PackageReference Remove` SourceLink workaround from `Directory.Build.targets`.
  Finding #10 (dotnet ro-verify writes) must also be resolved before the CI
  `verify` path is trustworthy for dotnet consumers.
