[![Quality gate](https://sonarcloud.io/api/project_badges/quality_gate?project=markstanden_defined)](https://sonarcloud.io/summary/new_code?id=markstanden_defined)

# defined

A single source of truth for my development project configuration files, workflow templates, and development tools to ensure consistency across projects.

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

The gate detects the stack (steps run in order `naming → node → node-checks →
node-coverage → dotnet → dotnet-coverage → shell → smoke → yaml → workflow →
tofu`), skips cleanly when an ecosystem is absent, and fails loudly when a
pinned tool is missing. Because `verify` never writes to the repo, the steps
that must write — `node-checks`, `node-coverage` and the `dotnet` family — work
in a scratch copy of the git scope under the container's `/tmp` (a read-only
mount cannot host `node_modules/`, `coverage/lcov.info` or `obj/`/`bin/`); the
repo checkout itself is never touched. Tool versions are pinned in
[`runtime/tool-versions.env`](runtime/tool-versions.env) — a pin change rebuilds
the image.

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
   byte-identical to the image's copy (updating it when the gate changes).
   Use `comply` every time — it is the whole local loop; `verify` is reserved
   for CI.

    Prettier runs to house defaults; a consumer-owned `prettier.config.mjs` (or
    any `.prettierrc*` / `prettier.config.*` file) at the repo root is honoured
    instead, so project preferences need no fork. Indentation stays owned by
    `.editorconfig`, which prettier gives higher priority than any config.

4. **Gate in CI** — nothing to add: `comply` installed
   `.github/workflows/defined--verify.yml`, and it gates every pull request and
   push on its own (no reusable-workflow ref, so there is no gate SHA in your
   workflow to keep in step).

    The workflow reads `.defined.json` for the image tag — the same pin the
    local launcher reads — so local and CI run the same image. Omitted `version`
    rides the current published image; a written pin restores immutability.
    Because the tag lives in exactly one place, local green = merge green by
    construction. The workflow is a managed file: change its triggers or steps
    by editing `.defined.json`/standards upstream, not by hand — a local edit is
    drift and fails `verify`.

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
image publication); they are not consumer templates.

## Standards

- [`standards/naming.md`](standards/naming.md) — naming doctrine index + workflow filename grammar
- [`standards/naming/shell.md`](standards/naming/shell.md) — shell function tiers, word order, verb vocabulary, file names
- [`standards/naming/typescript.md`](standards/naming/typescript.md) — TypeScript identifiers, CLI entry, module file names
- [`standards/yaml.md`](standards/yaml.md) — YAML lint/format behaviour (`yamllint -s` + prettier)
- [`standards/testing/unit-testing.md`](standards/testing/unit-testing.md) — C#/xUnit testing patterns (reviewer guidance)
- [`standards/testing/node-testing.md`](standards/testing/node-testing.md) — Node/TypeScript testing + module conventions (reviewer guidance)
- [`practices/architecture.md`](practices/architecture.md) — delivery/structure/code preferences
- [`standards/.editorconfig`](standards/.editorconfig) — editor + dotnet code style (installed by gate setup)
- [`standards/Directory.Build.props`](standards/Directory.Build.props) — common MSBuild properties (installed by gate setup)
- [`standards/.gitattributes`](standards/.gitattributes) — LF/whitespace checkout contract (installed by gate setup)
- [`standards/workflows/defined--verify.yml`](standards/workflows/defined--verify.yml) — the managed gate workflow, installed by gate setup
- [`standards/githooks/pre-commit`](standards/githooks/pre-commit) — optional reference commit hook that runs `defined verify` (opt-in, repo-owned)

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
├── practices/                       # docs / how-to
└── .github/workflows/                # defined--verify/test/publish
```

Consumers commit a `.defined.json` (optional immutable image tag under
`version` — omitted means the default published image — plus optional coverage
config) read by both the launcher and `defined--verify.yml`; this producer repo
commits its own versionless config, a coverage-only `.defined.json`, so the
gate is tested on the gate.
