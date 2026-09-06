<!-- update: agent=opencode | date=2026-09-01 | scope=practices/2026-09-01_rollout-energy-comparison.md -->

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
   `defined upgrade` verb. [NEEDS DECISION]

2. **Bootstrap refuses to adopt over differing managed files.** The gate's
   contract (by design) is byte-identical-or-fail: a differing `.editorconfig`
   or `Directory.Build.props` hard-fails `comply` with "resolve by hand, the
   gate never overwrites or merges". The template ships its own (richer,
   different) versions of both, so the first `comply` was blocked. Adoption
   into any repo that already has these files is a conscious decision to adopt
   the standards floor verbatim. This is the raises-only contract in action,
   but it deserves a documented adoption note.

3. **The template is not aligned with standards.** `csharp-template`'s
   `.editorconfig` (88 lines vs standards' 200) and `Directory.Build.props`
   differ substantially. Critically, the template's props carries
   `TargetFramework=net10.0` (and `ImplicitUsings`) that the empty
   `src/...Core.csproj` depends on — adopting the standards props (no TF)
   breaks the build unless TF moves into the csproj. The template must be
   re-aligned to standards before it can be a gate-ready starting point
   (Phase 3).

4. **The tightening layer is undocumented.** The template's stricter settings
   (`TreatWarningsAsErrors`, `Deterministic`) cannot live in the managed
   `Directory.Build.props` (byte-identical or fail). The unmanaged
   `Directory.Build.targets` is the natural "tighten here" layer. The
   raises-only story ("projects may tighten the floor") needs this mechanism
   documented.

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
   worth doing.

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
   build error for idiomatic xUnit `Method_State_Expected` test names. Resolved
   with a nested `tests/<proj>/.editorconfig` scoping CA1707 off for test code
   (the managed root `.editorconfig` stays byte-identical). Upstream: consider
   a test-scoped CA1707 policy in standards or document the pattern.
   [NEEDS DECISION]

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
