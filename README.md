[![Quality gate](https://sonarcloud.io/api/project_badges/quality_gate?project=markstanden_defined)](https://sonarcloud.io/summary/new_code?id=markstanden_defined)

# defined

**defined** — a portable, drop-in quality gate. A single container image
(`runtime/`) that detects any project's stack and runs the right checks,
backed by shared building blocks (`lib/`) and house standards (`standards/`).

## The gate: one command owns local verification

Install the `defined` launcher, then run it from a project root:

```bash
bash cli/install.sh        # one-time install into ~/.local/bin

defined comply             # bootstrap (seeded defaults + managed workflow + AGENTS block) → repair → verify
```

`cli/install.sh` resolves the revision to install (the current checkout when run
from a clone, otherwise the latest published `main`), downloads the launcher,
verifies it against a checksum embedded in the installer, and installs it
atomically. It is idempotent — re-running with the same revision is a no-op —
and `--rev <sha>` installs a specific revision.

The launcher also has a lifecycle surface:

```bash
defined version                  # launcher, pin, image, engine and drift
defined update [<sha>|latest]    # move the pin, launcher and image together
defined --version                # terse one-liner: defined <rev>
```

`defined version` is read-only and never fails on drift — it reports it — and
degrades to "unknown" for anything it cannot resolve offline (`DEFINED_OFFLINE=1`).
`defined update` resolves `latest` to a concrete SHA (never a mutable tag),
writes the pin into `.defined.json` as a working-tree change for you to commit,
reinstalls the launcher at that revision, then pulls the exact image. It refuses
to run in the defined source repo itself.

In the defined source repo itself, `comply` and `verify` never use the published
image: the image is built _from_ this code, so gating against it would test the
last release rather than the change in hand. Both verbs delegate to
`runtime/comply.sh`, which builds an image from the working tree and mounts
`runtime/`, `lib/` and `standards/` over the baked copies — `verify` runs its
read-only `--check-only` pass. A one-line note on stderr says so, keeping the
stdout report contract (exactly one `compliant` line when green) intact.

**Always use `comply` for local and agent work.** It bootstraps the managed
files, repairs safe findings, then re-verifies — one command, exit 0 only when
the checkout is green. `verify` exists solely for the pipeline: it is the
read-only check the installed `defined--verify.yml` runs in CI (never writes),
and is not the command for a developer to reach for.

The launcher is a bash script needing git + podman/docker (plus the standard
coreutils any bash environment has); it prefers podman, mounts the repo
read-write for `comply` and read-only for `verify`, and runs the exact image
pinned in the repo's `.defined.json` — so local green = merge green: the
installed CI workflow reads that same pin and no gate version is duplicated
anywhere (decision #36).

Set `DEFINED_ENGINE` to force an engine, and `DEFINED_OFFLINE=1` to run the
container with no network (`--network=none`). The gate's checks need no network,
and offline mode avoids podman's pasta backend, which fails on hosts without the
`tun` kernel module; dependency restore then uses the named volumes' cache, so
the image must already be present locally.

The gate detects the stack (steps run in order `naming → node-deps → node →
node-checks → node-coverage → dotnet → dotnet-coverage → shell → smoke → yaml →
workflow → tofu`), skips cleanly when an ecosystem is absent, and fails loudly
when a pinned tool is missing. Because `verify` never writes to the repo, the
steps that must write — `node-deps`, `node`, `node-checks`, `node-coverage`, the
`dotnet` family and `tofu` — work in a scratch copy of the git scope under the
container's `/tmp` (a read-only mount cannot host `node_modules/`,
`coverage/lcov.info`, `obj/`/`bin/` or `.terraform/`); the repo checkout itself
is never touched. Tool versions are pinned in
[`runtime/tool-versions.env`](runtime/tool-versions.env) — a pin change rebuilds
the image.

**Scope is git's.** Every step judges the repo's git content — tracked plus
untracked-but-not-ignored files (`git ls-files -co --exclude-standard`).
Gitignored paths are never analysed, locally or in CI, so local and CI agree by
construction; committed content is always gated. Tools that would otherwise walk
the filesystem (`prettier`, `gitleaks`) are pointed at the tracked list instead.

## Adopt the gate in a consumer repo

1. **Install the launcher** — fetch and run the installer, which verifies and
   installs `defined` onto PATH (normally `~/.local/bin/defined`):

    ```bash
    curl -fsSL -o install.sh https://raw.githubusercontent.com/markstanden/defined/main/cli/install.sh
    bash install.sh
    ```

    A bash script needing git + podman/docker.

2. **Commit the config** — add a `.defined.json` file. `version` is optional:
   omit it to ride the current published default image, or pin an immutable
   tag (e.g. the git SHA of the gate commit you're adopting) for
   reproducibility. Add optional `coverage` configuration:

    ```jsonc
    {
        "version": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        "coverage": {
            "node": {
                "command": "npm run test:coverage",
                "minimums": { "line": 80, "branch": 70 },
            },
            "dotnet": {
                "command": "dotnet test --collect:XPlat",
                "minimums": { "line": 80 },
            },
        },
    }
    ```

    Absent `coverage` (or an absent ecosystem entry) skips that coverage step;
    `command` generates the report in `comply` mode; omitted minimums default
    to 80% line coverage.

    Add optional `node` project checks to run the consumer's own
    ESLint/`tsc`/tests (and any other declared command) — the gate restores the
    package's dependencies first and resolves the consumer's local binaries, not
    the gate's:

    ```jsonc
    "node": {
        "checks": [
            { "name": "lint", "command": "eslint .", "fix": "eslint --fix ." },
            { "name": "typecheck", "command": "tsc --noEmit" },
            { "name": "test", "command": "vitest run" },
        ],
    }
    ```

    The flat form targets the sole tracked `package.json` (any depth); set `dir`
    for an explicit package, or `packages: [{ dir, install, checks }]` for a
    monorepo. Restore auto-detects `npm`/`yarn`/`pnpm` from the lockfile (override
    with `install`, or `false` to skip); a check's `fix` command runs in `comply`
    only, then the check re-runs. Absent `node` (or no `checks`) skips cleanly.

    Add optional `naming` rules to enforce your project's naming doctrine — the
    gate always enforces the workflow-filename grammar
    ([`standards/naming.md`](standards/naming.md)) and runs your command over
    the git scope:

    ```jsonc
    "naming": {
        "command": "quality/naming.sh",
        "fix": "quality/naming.sh --fix",
    }
    ```

    `command` must exit non-zero on violations; `fix` runs first in `comply`
    only. Absent `naming` runs the workflow grammar alone.

    The `eslint` key carries the house-step switches. Turn the step off when a
    repo deliberately owns its own lint entirely:

    ```jsonc
    "eslint": { "disable": true }
    ```

    The house config also carries a cyclomatic-complexity floor — every
    function, max 10 by default (ESLint core `complexity`, tighter than Sonar's
    cognitive 15 so a branchy function is named with its score at review
    time). Test files (`*.test.*`, `*.spec.*`) are exempt. Raise it or drop it
    per repo; a repo-owned `eslint.config.*` governs itself and is unaffected:

    ```jsonc
    "eslint": { "complexityMax": 12 }
    ```

    `false` drops the rule entirely.

    An `eslint` entry in `node.checks` is only needed to run your _own_
    config/toolchain at a version or with plugins the gate does not carry; a
    repo-owned `eslint.config.*` at the root is already run by the ESLint step
    itself.

    On a host that cannot run the managed GitHub workflow (Azure DevOps,
    GitLab, a private server), switch off its installation and check — local
    `comply` still runs every in-container step:

    ```jsonc
    "workflow": { "disable": true }
    ```

    `comply` then never seeds `.github/workflows/defined--verify.yml` and
    `verify` never fails on its absence; an already-present copy is left in
    place with a stderr notice (remove it yourself with `git rm`).

    `Directory.Build.props` is MSBuild plumbing: it is seeded only into repos
    with tracked `.csproj`/`.sln`/`.slnx` files, so a TypeScript-only repo that
    deletes it stays rid of it. A repo that has .NET files it does not want
    gated switches the dotnet tooling off entirely:

    ```jsonc
    "dotnet": { "disable": true }
    ```

    That turns the `dotnet` and `dotnet-coverage` steps off and stops the
    seeding; an already-seeded copy is yours — `git rm` it if unwanted. It
    cannot be combined with `coverage.dotnet`; the config parse rejects that
    combination.

    The `tofu` step runs `fmt`, `tflint`, `init` and `validate` — `fmt` over the
    tracked `.tf` files, and the rest once per module directory (the top-most
    directories holding tracked `.tf`), so a module under `infrastructure/` is
    actually checked, not skipped because the repo root has no `.tf`. Pin the
    directories explicitly when the layout is ambiguous:

    ```jsonc
    "tofu": { "dirs": ["infrastructure"] }
    ```

    **Coverage command examples** — the command must land the report at a fixed
    path: `coverage/lcov.info` (node) or `coverage.cobertura.xml` /
    `TestResults/coverage.cobertura.xml` (dotnet).

    ```jsonc
    "coverage": {
        "node": {
            "command": "node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info",
            "minimums": { "line": 90 },
        },
        "dotnet": {
            "command": "dotnet test && find . -path '*/TestResults/coverage.cobertura.xml' -exec cp {} TestResults/coverage.cobertura.xml \\;",
            "minimums": { "line": 90 },
        },
    }
    ```

    - The node example uses the built-in lcov reporter (zero dependencies); a
      vitest project instead runs `vitest run --coverage --reporter=lcov`.
    - The dotnet example works with a coverlet-instrumented test project
      (`CoverletOutput=TestResults/` in the csproj); the `find` stages the
      per-project report to the gate's fixed path. The SDK's
      `--collect:"XPlat Code Coverage"` works too but writes under a GUID
      subfolder, so staging is still required.
    - **Minimums are declared only here** (`.defined.json`) — CLI-declared.
      Don't duplicate them in XML (e.g. a coverlet `Threshold`): the gate is
      the single authority.

3. **Gate locally** — run `defined comply`. It bootstraps `.editorconfig`,
   `Directory.Build.props`, `.gitattributes` and the gate workflow
   (`.github/workflows/defined--verify.yml`) into the repo and seeds the
   AGENTS.md managed block, repairs safe findings, then re-verifies. The three
   config files are **seeded defaults**: installed only when absent, so a repo
   with its own rules keeps them and the gate never gated on theirs. The gate
   workflow and the AGENTS block are **managed**: `comply` keeps the workflow
   byte-identical to the image's copy (updating it when the gate changes). A
   non-GitHub host opts out with `"workflow": { "disable": true }` (see above),
   and `Directory.Build.props` is seeded only when tracked .NET projects exist
   (or never, with `"dotnet": { "disable": true }`).

    **Tighten the floor; don't fork it.** The house config is a floor, not a
    straitjacket — the seeded files are yours once installed (the gate never
    overwrites or re-gates them), so a repo may go stricter. Keep that
    tightening in a layer you own rather than editing the seeded baseline: for
    .NET, put project-specific settings (e.g. `TreatWarningsAsErrors`,
    `Deterministic`, extra analyzers) in an unmanaged `Directory.Build.targets`,
    which MSBuild imports after `Directory.Build.props`. The house default then
    stays recognisable and your deltas are explicit and diffable. The managed
    gate workflow is the one exception — it stays byte-identical to the image
    and is never hand-edited.

    Prettier runs to house defaults; a consumer-owned `prettier.config.mjs` (or
    any `.prettierrc*` / `prettier.config.*` file) at the repo root is honoured
    instead, so project preferences need no fork. Indentation stays owned by
    `.editorconfig`, which prettier gives higher priority than any config.

    ESLint is the correctness half of the loop. With no `eslint.config.*` at the
    repo root the gate lints the git-scoped JS/TS with its **baked house config**
    (flat config, selected with `--config`, plugins resolved in-image — nothing
    is installed into or written to the repo). A repo-owned `eslint.config.*` is
    honoured instead: the gate runs _that_ config through the repo's own restored
    ESLint, and writes `eslint.config.defined.mjs` beside it as an example of the
    current house default. v1 of the house config is deliberately narrow — the
    super-linear-regex floor (`regexp/no-super-linear-move` +
    `regexp/no-super-linear-backtracking`, the local reproduction of Sonar
    `typescript:S8786`) with `eslint-config-prettier` last so ESLint never votes
    on formatting. Switch the step off with `"eslint": { "disable": true }`.

    | tool            | the gate brings                                       | a repo's own copy                  |
    | --------------- | ----------------------------------------------------- | ---------------------------------- |
    | `.editorconfig` | seeded default, installed only when absent            | kept; `verify` never gates on it   |
    | prettier        | baked `prettier.config.mjs`, selected with `--config` | wins by selection; nothing written |
    | ESLint          | baked `eslint.config.mjs`, selected with `--config`   | runs theirs; house example written |

    Run the loop through the gate rather than against host tooling: `defined
 comply` applies what ESLint can auto-fix (`--fix`) and the re-check reports
    the remainder. Neither the house config nor its plugins live in your
    `package.json`, by design.

4. **Gate in CI** — nothing to add: `comply` installed
   `.github/workflows/defined--verify.yml`, and it gates every pull request and
   push on its own (no reusable-workflow ref, so there is no gate SHA in your
   workflow to keep in step). It reads the same `.defined.json` pin as the local
   launcher, so local and CI run the same image: a written pin is immutable, an
   omitted `version` rides the current published image. Like the AGENTS block it
   is managed — change it upstream, never by hand. A host that cannot run GitHub
   Actions opts out with `"workflow": { "disable": true }`.

### Windows hosts (WSL2)

The launcher is a bash script: on Windows, run it **inside WSL**. Install it
there (the installer command above, run inside the distro), with Docker Engine
installed in WSL itself — no Docker Desktop required; the engine is whatever
`podman`/`docker` resolves to inside the distro.

So IDE terminals and agent shells on the Windows side can reach it, put a
**git-bash shim** on the Windows PATH — one small file at, say,
`C:\Users\<me>\.local\bin\defined`:

```bash
#!/usr/bin/env bash
# git-bash shim: forward to the WSL launcher with the CWD translated.
set -e
export MSYS_NO_PATHCONV=1
exec wsl.exe -d Ubuntu-24.04 --cd "$(pwd -W)" -- /home/<me>/.local/bin/defined "$@"
```

Three pitfalls the shim has to handle — each cost someone an afternoon:

1. **`wsl.exe` re-joins argv without quoting.** A compound command
   (`bash -lc 'cd "$(wslpath ...)" && defined "$@"'`) loses its inner quotes on
   the way through, so the remote shell word-splits the script. Passing
   `--cd <windows-path>` plus one simple command avoids quoting entirely.
2. **WSL non-login shells append the Windows PATH.** Call the WSL launcher by
   **absolute path**: with a bare `defined`, a non-login WSL shell (no
   `~/.profile`) resolves `$PATH` past the appended Windows entries, finds the
   shim itself and re-runs it inside WSL. The launcher detects that — its
   Windows-side copy lives under `/mnt/...` — and dies naming the problem
   instead of recursing.
3. **git-bash path conversion mangles POSIX-looking arguments.**
   `/home/<me>/.local/bin/defined` arrives at `wsl.exe` rewritten as
   `C:/.../Git/home/...` unless `MSYS_NO_PATHCONV=1` is set.

## Quality pipeline

This repo's own CI (`defined--test.yml`) also runs a SonarQube Cloud scan,
forcing an **issue-free SonarQube gate** on the default branch — the badge at
the top is that signal for contributors. The `defined` gate feeds it: run
`defined comply` locally so lint/format/coverage issues are caught before they
reach the more sophisticated server gate. The two coexist — `defined` is the
cheap early gate, SonarQube holds the deeper line, and no `defined` workflow
runs a Sonar scan in CI. The identity files (`sonar-project.properties`,
`.sonarlint/connectedMode.json`) keep IDE analysis and the scanner in step;
neither contains secrets.

## Workflow templates

There is exactly one consumer-facing gate workflow:
[`standards/workflows/defined--verify.yml`](standards/workflows/defined--verify.yml).
`comply` installs it into a consumer repo at `.github/workflows/defined--verify.yml`
as a **managed file** — byte-identical to the standards copy, checked by
`verify` — so consumers never hand-edit it and never pin a gate ref.

It owns its own triggers (`pull_request` and `push`, name-agnostic) and reads
the repo's committed `.defined.json` for the image tag — no inputs — so it runs
the same pinned image as the local launcher. It contains no gate version: the
only gate SHA anywhere is the one in `.defined.json` (decision #36).

`defined--test.yml` and `defined--publish.yml` are this repo's own CI (tests and
image publication); they are not consumer templates. `defined--publish.yml` runs
on **every** main push — deliberately unfiltered, so every main commit carries an
image tag and `defined update latest` always resolves to a pullable SHA.

## Standards

- [`standards/naming.md`](standards/naming.md) — naming doctrine index + workflow filename grammar
- [`standards/naming/shell.md`](standards/naming/shell.md) — shell function tiers, word order, verb vocabulary, file names
- [`standards/naming/typescript.md`](standards/naming/typescript.md) — TypeScript identifiers, CLI entry, module file names
- [`standards/yaml.md`](standards/yaml.md) — YAML lint/format behaviour (`yamllint -s` + prettier)
- [`standards/shell.md`](standards/shell.md) — shell script rules (bash shebang, `[[ ]]`, explicit `return`)
- [`standards/testing/unit-testing.md`](standards/testing/unit-testing.md) — C#/xUnit testing patterns (reviewer guidance)
- [`standards/testing/node-testing.md`](standards/testing/node-testing.md) — Node/TypeScript testing + module conventions (reviewer guidance)
- [`standards/node-eslint.md`](standards/node-eslint.md) — the house ESLint step: what it owns, how to override, the v1→v2 growth plan
- [`practices/architecture.md`](practices/architecture.md) — delivery, structure, code and working-style preferences
- [`standards/.editorconfig`](standards/.editorconfig) — editor + dotnet code style (installed by gate setup)
- [`standards/Directory.Build.props`](standards/Directory.Build.props) — common MSBuild properties (installed by gate setup)
- [`standards/.gitattributes`](standards/.gitattributes) — LF/whitespace checkout contract (installed by gate setup)
- [`standards/workflows/defined--verify.yml`](standards/workflows/defined--verify.yml) — the managed gate workflow, installed by gate setup
- [`standards/githooks/pre-commit`](standards/githooks/pre-commit) — optional
  reference commit hook that runs `defined verify` (opt-in, repo-owned).
  Deferring to the gate means it can never format to different rules than CI; it
  is a full pass over the working tree and `--no-verify` bypasses it, so it is
  convenience, not a guarantee.

## Project structure

```bash
defined/
├── cli/                             # installed host launcher (no gate logic)
│   ├── defined                      # bash; needs git + podman/docker
│   └── install.sh                   # verified, idempotent installer
├── runtime/                         # the container image (the gate)
│   ├── Containerfile                # node 26 slim base, pinned tools
│   ├── tool-versions.env            # single source of tool version pins
│   ├── comply.sh                    # internal source-development shim
│   ├── comply.mts                   # comply/verify orchestration
│   ├── setup.mts                    # bootstrap/check implementation
│   ├── lib/                         # gate-specific core (ctx, severities, blocks)
│   ├── steps/                       # one module per ecosystem check
│   └── config/                      # tool configs travelling in the image
├── lib/                             # shared building blocks (proc, paths, git)
├── standards/                       # house standards and tools
│   └── workflows/defined--verify.yml # managed gate workflow (installed by setup)
├── practices/                       # architecture + working-style guidance
├── records/                         # historical session records (not guidance)
└── .github/workflows/                # defined--verify/test/publish
```

Consumers commit a `.defined.json` (optional immutable image tag under
`version` — omitted means the default published image — plus optional coverage
config) read by both the launcher and `defined--verify.yml`; this producer repo
commits its own versionless config, a coverage-only `.defined.json`, so the
gate is tested on the gate.
