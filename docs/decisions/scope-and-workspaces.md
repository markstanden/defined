---
Area: decisions
Keywords: scope, allowlist, scope.include, dotnet.workspaces, work repos, content checks, scratch, notices, scan, glob
Summary: A repository can narrow the content checks to a declared allowlist (`scope.include`) and pin the .NET workspaces it gates (`dotnet.workspaces`), while the repository stays the default scope and the working copy stays whole.
---

# Decision — a declared content scope and pinned .NET workspaces

## Facts

- The gate's scope is git's: `git ls-files -co --exclude-standard`
  (`lib/git.mts`). Tracked files cannot be ignored out of it, so a work repo
  with trees that will never be house-clean had no way to gate part of itself.
- The `.defined.json` grammar had no path concept. Its keys were `version`,
  `coverage.{node,dotnet}`, `node`, `naming`, `tofu`, `eslint`, `workflow`,
  `dotnet` and `purity` (`runtime/lib/config.mts`).
- Every file-list step takes that inventory verbatim: `shell` filters every
  tracked `*.sh` (`runtime/steps/shell.mts`), `yaml` every tracked YAML
  (`runtime/steps/yaml.mts`), and `tofu` discovers its module dirs from the same
  list.
- The no-fix scratch copy is materialised from that same list
  (`runtime/lib/scratch.mts`), and the .NET, node and coverage steps work in it.
  Filtering the list therefore also removes files from the build.
- .NET workspace discovery requires exactly one `.slnx`, one `.sln`, or one lone
  `.csproj`, and throws otherwise (`runtime/steps/dotnet.mts`). A scoped .NET
  repo contains several projects and, usually, no solution.
- `dotnet-coverage` declares `needs: ["dotnet"]` (`runtime/comply.mts`), and a
  skipped prerequisite counts as successful (`isSuccessful`), so a scoped
  `dotnet` step is also what unblocks a scoped coverage command.
- Notices came only from the bootstrap phase (`setup.drift`), so `scan` — which
  never runs one — could not report any consumer config drift.
- `globToRegExp` lived privately in `runtime/lib/purity.mts`.

## Facts — what this change adds

- `scope.include`: a non-empty array of repo-relative selectors in the shared
  glob dialect, deduped, with a trailing `/` normalised to `/**`. Absent or an
  empty `scope` object means the whole git scope.
- `dotnet.workspaces`: a non-empty array of repo-relative `*.sln`, `*.slnx` or
  `*.csproj` paths, deduped, run in declared order. It replaces discovery.
  `disable` plus `workspaces` is a parse error, as `disable` plus
  `coverage.dotnet` already was.
- `SCOPED_STEP_IDS` names the six steps the scope narrows (`node`, `eslint`,
  `purity`, `shell`, `yaml`, `tofu`), derived from a `scoped` flag on the run
  plan. `StepInput` carries the full `files` and the narrowed `checkFiles`; the
  three steps that build the scratch take `scratchFiles` for materialisation and
  config/identity discovery. Dependency restore (`node-deps`) sees the whole
  inventory: it is machinery, and a config-declared plugin must resolve from
  wherever its manifest lives.
- A scope matching no file in the git scope fails every scoped step with
  `scope: scope.include matches no file in the git scope (N selector(s))`;
  machinery steps still report.
- `configDrift` is exported and computed for `scan`, so a narrowed scope is
  visible on the verb a work repo runs. `buildResult` merges it through a new
  `notices` input; comply/verify output is unchanged.
- The glob dialect moved to `runtime/lib/glob.mts`; purity imports it and keeps
  exporting `selectorMatches`, so its documented behaviour is unchanged.

## Inferred

- An allowlist was chosen over a denylist. A denylist leaves every newly added
  folder ungated by default, which is the silent-drift failure mode; an
  allowlist is explicit about what is judged and dates the moment it stops
  covering something.
- The scope filters what is _reported_, never the working copy. Narrowing the
  scratch would break every build that references an out-of-scope project, and
  a gate that cannot build reports nothing useful. This is why the scratch,
  the consumer-config probes, the `.editorconfig` identity inputs and the
  cache identity all keep the full inventory.
- Gate machinery keeps the full scope: bootstrap, the managed workflow check,
  the smoke probe and the naming step's workflow grammar judge the gate's own
  work, not the consumer's code. The declared consumer commands
  (`node.checks`, `coverage.*.command`, `naming.command`) keep it too — their
  own scripts decide what they read.
- An empty scope is an error rather than a pass. A typo in a selector would
  otherwise turn the gate into a no-op that reads green, which is the exact
  failure a narrowing feature invites.
- The content caches need no scope input: prettier's and ESLint's verdicts are
  file-local (content, config, ignore files, `.editorconfig`), so a file
  entering or leaving scope reuses a verdict that is still valid. The identity
  deliberately still hashes the **full** list's `.prettierignore` and
  `.editorconfig` files, because a root `.editorconfig` governs in-scope files
  even when it is itself out of scope.
- The narrowed list belongs only where a finding is produced. Every signal that
  asks what the repository _is_ — the scratch inventory, the node manifest and
  markdown probes, consumer config and ignore discovery, the cache identity,
  dependency restore — reads the full inventory. Passing the scope to one of
  them silently disables a check instead of narrowing it: reviewing this change
  found prettier skipping a `src/**` scope entirely because the root
  `package.json` sat outside it, and the config-triggered root restore lost to
  the same leak.
- `dotnet.workspaces` belongs beside the scope rather than inside it: the scope
  says which findings are reported, the workspaces say what is built, and a
  repo may legitimately build a reference it does not report on.

## Tested

- `node --test` (679 tests): the glob dialect (segment, `**/`, `?`, anchoring,
  metacharacter escaping), scope resolution and the whole-inventory default,
  config accept/reject tables for both keys including the trailing-slash
  normalisation, dedupe and the two mutual exclusions, pass threading (scratch
  keeps the full list, checks see the narrowed one), the zero-match failure
  leaving machinery running, the scope notice on `scan`, and the .NET workspace
  loop (declared order, first failure naming its workspace, an out-of-scope
  entry failing before restore, and fix-mode restore/format per workspace).
- The repo's own gate: `./runtime/comply.sh`.

## Open questions

- **`naming.command` scoping.** The consumer's script owns its own selection, so
  `scope.include` does not narrow it. Narrowing the argument list it receives
  would be a second, weaker selector mechanism.
- **Per-step excludes.** A `yaml.exclude` next to `scope.include` would let a
  repo keep the scope whole and exempt one step. Not added: two overlapping
  selection mechanisms make what was judged harder to read, not easier.
- **`defined explain scope`.** Explain resolves step and rule ids only; a
  config-key topic needs a third topic kind. The README carries the config
  contract for now.
- **Skip notices under a narrow scope.** A step that finds nothing to check
  says so in the whole-repository voice ("no tracked *.sh files") even when the
  scope is what emptied it. The `scope.include` notice is always alongside, so
  the operator can tell, but the per-step wording does not distinguish the two
  cases.
- **CI parity.** A gitignored scope config narrows local runs only. If a work
  repo ever runs the gate in CI, the committed config (or its absence) decides
  there, so local green does not imply merge green for that repo.
