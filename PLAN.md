<!-- update: agent=opencode | date=2026-08-31 | scope=PLAN.md -->

# PLAN — defined: portable quality gate

`defined` is a portable engineering quality gate that works against **any**
project. Standards are defined once, distilled into agent guidance, and enforced
mechanically by one pinned container runtime, exposed through an agent-first
local CLI and one reusable pipeline workflow: local green = pipeline green.

`defined` is deliberately **not** a general CI/CD runtime: no release artifacts,
deployment, infrastructure operations, hosted service wrappers, or bespoke
build/test pipeline catalogue. A universally-applicable check belongs in the
gate; a project-specific delivery action stays with that project.

This is the working, living plan. Decisions and rationale that are no longer
current live in the git history — the plan keeps only what is true today. The
consumer-facing documentation is the README.

## Scope and API refocus

One universal quality gate, three execution surfaces:

```text
                         STANDARDS
                             │
                ┌────────────┴────────────┐
                ▼                         ▼
        AGENT GUIDANCE               DEFINED IMAGE
                │                         │
                │              ┌──────────┼──────────┐
                ▼              ▼          ▼          ▼
              AGENT         comply     verify     CI verify
                │              │          │          │
                └──────────────┴──────────┴──────────┘
                                      │
                                      ▼
                                COMPLIANT CODE
```

- **Standards** define what good looks like (shared config, practices, floors).
- **Agent guidance** gives an LLM the minimum completion contract.
- **The image** is the only enforcement runtime — detects ecosystems, repairs
  safe findings, verifies the rest.
- **Local/agent** execution uses the installed `defined` launcher; **pipeline**
  execution uses only `defined--verify.yml` (read-only verify).

Explicitly **outside** the product: release-artifact build/publish, SWA/app
deployment, OpenTofu plan/apply/destroy, healthcheck orchestration, bespoke
Playwright runners, hosted SonarQube wrappers, and workflow/pipeline-module
catalogues generally.

SonarQube is a **coexist, not gate, integration**: the producer repo's own CI
runs an issue-free SonarQube gate as a deeper server-side line, while the gate
enforces coverage locally (`node-coverage`/`dotnet-coverage` parse lcov/
Cobertura against `.defined.json` minimums). SonarQube coverage gating would
need committed-and-pushed server analysis — a round-trip that breaks local
green = pipeline green — so it stays out of the step order. Consumers who want
it run the scan in their own pipeline against the gate-generated report.

### Checks and step order

Steps run in fixed order, strictly sequentially:

```text
naming → node → node-coverage → dotnet → dotnet-coverage → shell → smoke → yaml → workflow → tofu
```

**Scope — the gate's universe is git's.** Every step judges the repo's git
content (`git ls-files -co --exclude-standard`: tracked plus untracked-but-
not-ignored). Gitignored paths — build dirs, local `.env`, scratch — are never
analysed, locally or in CI, so a gitignored secret can never make local red /
CI green (a whole-tree scan would). Tools that walk the filesystem rather than
the git list are brought into scope explicitly: `prettier` runs over the
tracked file list (filtered to parseable extensions) instead of `.`, and
`gitleaks` runs against a generated config (default rules + an allowlist of
the git-ignored paths) instead of a raw `dir .`. `comply` re-fetches the
tracked list _after_ bootstrap, because setup itself writes `.defined.json`
and the `AGENTS.md` block. Raises-only stands: a consumer who gitignores
something gets it excluded everywhere; committed content is always gated.

- Each ecosystem step activates on detection (a `package.json`/`*.md` for
  `node`, a `.csproj`/`.sln`/`.slnx` for `dotnet`, lowercase `*.sh` for `shell`,
  `.yml`/`.yaml` for `yaml`, workflow files for `workflow`, root tofu files for
  `tofu`); missing ecosystems skip cleanly.
- Coverage steps (`node-coverage`, `dotnet-coverage`) activate on a `.defined.json`
  `coverage` entry for their ecosystem; absent entry = skip. They run the
  consumer's coverage command — in the repo for `fix`, in the no-fix scratch for
  `verify` — then enforce the configured line/branch/function minimums (default
  80% line) from the resulting lcov / Cobertura report. No committed or staged
  report is ever required: `verify` generates and checks one deterministically.
- The `dotnet` family must write `obj/`/`bin/`/`TestResults/`, which a read-only
  `verify` (local `defined verify`, CI) cannot do in place. No-fix therefore
  runs `dotnet` and `dotnet-coverage` against a **scratch copy of the repo's git
  scope under `/tmp`** (`runtime/lib/scratch.mts`) — one copy shared by both
  steps, created only when dotnet activates, cleaned after the pass. Fix mode
  builds in the repo as before. The repo mount is never written by either mode.
- `smoke` always probes the container's git.
- Missing applicable tools fail loudly pointing at the Containerfile — there is
  no optional tier.

### Final public API

```bash
defined comply   # always: the local/agent loop
defined verify   # pipeline-only: the read-only check
```

- **`comply`** (the only verb a developer or agent reaches for): resolve git
  root → read/validate `.defined.json` pin → pull image → bootstrap managed
  configs + AGENTS block → full internal `fix` pass → fresh internal `no-fix`
  verify pass → exit 0 only when green. The second pass is mandatory. Always
  use `comply` for local work; `verify` is not it.
- **`verify`**: resolve pin → check managed artifacts present/current (never
  install) → full `no-fix` pass → non-zero for any drift/finding/failure.
  Pipeline-only — the sole verb callable from `defined--verify.yml`, and not
  the command for local use.
- **Output contract:** success = exit 0 + one stable `compliant` line (success
  chatter suppressed); failure = non-zero + stable agent-actionable detail
  (phase, step, tool/rule, files, whether repair attempted, what remains).

### Launcher and release identity

- Installable `cli/defined` bash launcher (`#!/usr/bin/env bash`, `[[ ]]`),
  installed on PATH (normally `~/.local/bin/defined`); no gate behaviour; needs
  git + podman/docker; prefers podman; mounts repo read-write for `comply`,
  read-only for `verify`.
- `.defined.json` holds the optional immutable image tag under its `version`
  field, plus optional per-ecosystem coverage configuration. An omitted
  `version` (or a missing file) means the current published default image
  (`latest`); a written pin must be immutable — empty, `latest`, malformed or
  conflicting overrides are rejected. Offline runs succeed only with the exact
  image present.
- `runtime/comply.sh` is an internal source-development shim, not a third
  public API; it defaults to the `comply` verb and `--check-only` runs the
  read-only no-fix pass.
- Release identity is immutable (same commit SHA across all three surfaces):

```text
Git SHA
├── reusable workflow ref: markstanden/defined/...@<sha>
├── image tag:             ghcr.io/markstanden/defined:<sha>
└── consumer pin:          .defined.json "version" → <sha>
```

GitHub forbids an expression in a reusable workflow `uses:` ref, so the
consumer writes the workflow SHA in YAML; `.defined.json` removes the
separate `image-tag` input so local and CI share one source. Local green =
merge green only while the workflow ref and `.defined.json` pin match — the
consumer keeps those in step. An omitted `version` deliberately rides the
current published default image (`latest`) — defaults are obvious, a written
pin is the override that restores immutability.

### Consumer configuration

`.defined.json` at the repo root is the single consumer configuration file.
`version` is optional — omitted means the launcher uses the current published
default image; a written pin is immutable (a 7–40 char hex SHA). Optional
`coverage` configuration activates the per-ecosystem coverage gate:

```jsonc
{
    "version": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "coverage": {
        "node": {
            "command": "npm run test:coverage",
            "minimums": { "line": 80, "branch": 70, "function": 90 },
        },
        "dotnet": {
            "command": "dotnet test --collect:XPlat",
            "minimums": { "line": 80 },
        },
    },
}
```

- Absent `coverage` section (or absent ecosystem entry) = that coverage step
  skips.
- `command` is the shell command that generates the coverage report; it runs
  in `fix` mode, while `no-fix` mode only parses an existing report.
- `minimums` per metric are optional; an omitted metric is not checked. When
  the `minimums` key is absent, the step defaults to 80% line coverage.
- The gate parses `node` reports as lcov (`coverage/lcov.info`) and `dotnet`
  reports as Cobertura XML (`coverage.cobertura.xml` or
  `TestResults/coverage.cobertura.xml`).

### Bootstrap contract

`comply` installs managed root configs (`.editorconfig`,
`Directory.Build.props`) and a marker-delimited block in consumer `AGENTS.md`
from the image-baked versions, and seeds that block idempotently without
clobbering project content. Managed files are compared byte-for-byte: an
identical file is left alone, any difference is drift and fails. There is no
semantic merge — the managed files are the floor and must be an exact copy.

The managed `.editorconfig` carries a test-code policy under the convention
glob `[tests/**/*.cs]` (test projects live under `tests/`): xUnit idioms trip
CA1707 (underscored `Method_State_Expected` names) and CA1515 (xUnit discovers
only public test classes), both false positives for test code only, so they are
relaxed there. Production code keeps the strict floor, and nothing must be made
public just to be testable — `InternalsVisibleTo` is the supported pattern for
reaching internal members from tests.

### Target repository shape

```text
defined/
├── cli/
│   └── defined                       # installed host launcher; no gate logic
├── runtime/
│   ├── Containerfile                 # pinned, self-contained gate image
│   ├── tool-versions.env             # tool pins used to build the image
│   ├── comply.mts                    # comply/verify orchestration
│   ├── setup.mts                     # internal bootstrap/check implementation
│   ├── lib/                          # gate-specific core + tests (incl. config.mts)
│   ├── steps/                        # detected ecosystem checks + tests
│   └── config/                       # travelling tool/agent configuration
├── lib/                              # shared gate helpers: git, paths, proc
├── standards/                        # authoritative house standards/config
├── practices/                        # explanatory guidance
└── .github/workflows/
    ├── defined--verify.yml           # sole consumer-facing workflow
    ├── defined--test.yml             # this repo's CI
    └── defined--publish.yml          # image publication
```

The producer repo commits a versionless `.defined.json` — a coverage-only
config (a self-referential `version` pin is impossible by construction, and an
omitted version means the default image, which the source-development shim
never consults anyway). `comply` on this repo is the coverage gate it ships,
self-hosted on the gate's own test suite.
