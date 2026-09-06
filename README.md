[![Quality gate](https://sonarcloud.io/api/project_badges/quality_gate?project=markstanden_defined)](https://sonarcloud.io/summary/new_code?id=markstanden_defined)

# defined

A single source of truth for my development project configuration files, workflow templates, and development tools to ensure consistency across projects.

**defined** — a portable, drop-in quality gate. A single container image
(`runtime/`) that detects any project's stack and runs the right checks,
backed by shared building blocks (`lib/`) and house standards (`standards/`).

## The gate: one command owns local verification

Install the `defined` launcher, then run it from a project root:

```bash
install -m 755 cli/defined ~/.local/bin/defined   # one-time install

defined comply    # bootstrap (configs + AGENTS block) → repair → verify
```

**Always use `comply` for local and agent work.** It bootstraps the managed
configs, repairs safe findings, then re-verifies — one command, exit 0 only
when the checkout is green. `verify` exists solely for the pipeline: it is the
read-only check `defined--verify.yml` runs in CI (never writes), and is not the
command for a developer to reach for.

The launcher is a bash script needing git + podman/docker (plus the standard
coreutils any bash environment has); it prefers podman, mounts the repo
read-write for `comply` and read-only for `verify`, and runs the exact image
pinned in the repo's `.defined.json` — so local green = merge green: CI runs
that same image as long as the workflow ref and the `.defined.json` pin
match (keep them in step).

The gate detects the stack (steps run in order `naming → node → node-coverage →
dotnet → dotnet-coverage → shell → smoke → yaml → workflow → tofu`), skips
cleanly when an ecosystem is absent, and fails loudly when a pinned tool is
missing. Because `verify` never writes to the repo, the dotnet steps build in a
scratch copy of the git scope under the container's `/tmp` (a read-only mount
cannot host `obj/`/`bin/`); the repo checkout itself is never touched. Tool versions are pinned in
[`runtime/tool-versions.env`](runtime/tool-versions.env) — a pin change rebuilds
the image.

## Adopt the gate in a consumer repo

1. **Install the launcher** — copy `cli/defined` onto PATH (normally
   `~/.local/bin/defined`); a bash script needing git + podman/docker.
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

3. **Gate locally** — run `defined comply`. It bootstraps `.editorconfig` and
   `Directory.Build.props` into the repo root and seeds the AGENTS.md managed
   block, repairs safe findings, then re-verifies. Managed files are installed
   from the image and must stay byte-identical — any difference is drift and
   fails. Use `comply` every time — it is the whole local loop; `verify` is
   reserved for CI.
4. **Gate in CI** — call the reusable `defined--verify.yml` workflow, pinned
   to the same git sha as the pin:

    ```yaml
    jobs:
        quality:
            uses: markstanden/defined/.github/workflows/defined--verify.yml@<shortsha>
    ```

    The workflow reads `.defined.json` for the image tag — the same pin the
    local launcher reads — so local and CI run the same image. Omitted
    `version` defaults to the current published image; a written pin restores
    immutability. Keep the workflow ref SHA and the `.defined.json` pin in
    step: only when they match is local green = merge green.

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

The gate exposes exactly one consumer-facing reusable workflow:
`defined--verify.yml` — quality scan for any repo. Call it from a consumer
pipeline via a gitsha-pinned ref. Filename grammar:
`<namespace>--<loose-verb>[--<target>]` (see [`standards/naming.md`](standards/naming.md)).

```yaml
jobs:
    quality:
        uses: markstanden/defined/.github/workflows/defined--verify.yml@<shortsha>
```

The workflow reads the repo's committed `.defined.json` for the image tag —
no inputs — so it runs the same pinned image as the local launcher.
`defined--test.yml` and `defined--publish.yml` are this repo's own CI (tests
and image publication); they are not consumer templates.

A full example pipeline is in [`standards/workflows/pipeline.example.yml`](standards/workflows/pipeline.example.yml).

## Standards

- [`standards/naming.md`](standards/naming.md) — workflow filename grammar
- [`standards/testing/unit-testing.md`](standards/testing/unit-testing.md) — C#/xUnit testing patterns (reviewer guidance)
- [`standards/testing/node-testing.md`](standards/testing/node-testing.md) — Node/TypeScript testing + module conventions (reviewer guidance)
- [`practices/architecture.md`](practices/architecture.md) — delivery/structure/code preferences
- [`standards/.editorconfig`](standards/.editorconfig) — editor + dotnet code style (installed by gate setup)
- [`standards/Directory.Build.props`](standards/Directory.Build.props) — common MSBuild properties (installed by gate setup)

## Project structure

```bash
defined/
├── cli/                             # installed host launcher (no gate logic)
│   └── defined                      # bash; needs git + podman/docker
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
├── practices/                       # docs / how-to
└── .github/workflows/                # defined--verify/test/publish
```

Consumers commit a `.defined.json` (optional immutable image tag under
`version` — omitted means the default published image — plus optional coverage
config) read by both the launcher and `defined--verify.yml`; this producer repo
commits its own versionless config, a coverage-only `.defined.json`, so the
gate is tested on the gate.
