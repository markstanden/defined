<!-- update: agent=opencode | date=2026-09-21 | scope=PLAN.md -->

# PLAN — defined: portable quality gate

`defined` is a portable engineering quality gate that works against **any**
project. Standards are defined once, distilled into agent guidance, and enforced
mechanically by one pinned container runtime, exposed through an agent-first
local CLI and one managed pipeline workflow: local green = pipeline green.

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
naming → node-deps → node → node-checks → node-coverage → dotnet → dotnet-coverage → shell → smoke → yaml → workflow → tofu
```

**Scope — the gate's universe is git's.** Every step judges the repo's git
content (`git ls-files -co --exclude-standard`: tracked plus untracked-but-
not-ignored). Gitignored paths — build dirs, local `.env`, scratch — are never
analysed, locally or in CI, so a gitignored secret can never make local red /
CI green (a whole-tree scan would). Tools that walk the filesystem rather than
the git list are brought into scope explicitly: `prettier` runs over the
tracked file list (filtered to parseable extensions) instead of `.`, and
`gitleaks` runs against a generated config (default rules + an allowlist of
the git-ignored paths) instead of a raw `dir .`, and the consumer's optional
`.gitleaksignore` fingerprint baseline is honoured via an explicit
`--gitleaks-ignore-path` pinned to the repo root (so known-good findings stay
suppressed and scope never widens). `comply` re-fetches the
tracked list _after_ bootstrap, because setup itself writes `.defined.json`
and the `AGENTS.md` block. Raises-only stands: a consumer who gitignores
something gets it excluded everywhere; committed content is always gated.

- Each ecosystem step activates on detection (a `package.json`/`*.md` for
  `node`, a `.csproj`/`.sln`/`.slnx` for `dotnet`, lowercase `*.sh` for `shell`,
  `.yml`/`.yaml` for `yaml`, workflow files for `workflow`, root tofu files for
  `tofu`); missing ecosystems skip cleanly. `node-deps` restores the consumer's
  dependencies before `node` and `node-checks` run: every declared
  `node.packages` entry, plus the root package whenever a consumer Prettier
  config is tracked, so a config-declared plugin resolves on a fresh checkout
  (issue #40). `node-checks` activates on a `.defined.json` `node` entry and runs
  the consumer's declared lint/typecheck/test commands against the consumer's
  own installed toolchain (nested and monorepo `package.json` locations
  supported; the sole tracked manifest needs no `dir`). Absent entry = skip; a
  declared package without a manifest fails loudly.
- Coverage steps (`node-coverage`, `dotnet-coverage`) activate on a `.defined.json`
  `coverage` entry for their ecosystem; absent entry = skip. They run the
  consumer's coverage command — in the repo for `fix`, in the no-fix scratch for
  `verify` — then enforce the configured line/branch/function minimums (default
  80% line) from the resulting lcov / Cobertura report. No committed or staged
  report is ever required: `verify` generates and checks one deterministically.
- Dependency restore, formatting, node-checks and coverage must write into the
  repo (`node_modules/` for node-deps, prettier's rewrites for node,
  `coverage/lcov.info` for node-coverage, `obj/`/`bin/`/`TestResults/` for
  dotnet), which a read-only `verify` (local `defined verify`, CI) cannot do in
  place. No-fix therefore runs `node-deps`, `node`, `node-checks`,
  `node-coverage`, `dotnet` and `dotnet-coverage` against a **scratch copy of
  the repo's git scope under `/tmp`** (`runtime/lib/scratch.mts`) — one copy
  shared across those steps, created on first use, cleaned after the pass. Fix
  mode works in the repo as before. The repo mount is never written by either
  mode.
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
  files + AGENTS block → full internal `fix` pass → fresh internal `no-fix`
  verify pass → exit 0 only when green. The second pass is mandatory. Always
  use `comply` for local work; `verify` is not it.
- **`verify`**: resolve pin → check managed artifacts present/current (never
  install) → full `no-fix` pass → non-zero for any drift/finding/failure.
  Pipeline-only — the sole verb callable from `defined--verify.yml`, and not
  the command for local use.
- **Output contract:** success = exit 0 + one stable `compliant` line (success
  chatter suppressed); failure = non-zero + stable agent-actionable detail
  (phase, step, tool/rule, files, whether repair attempted, what remains).

### Commit hooks

Defined does **not** install or manage git hooks — the bootstrap surface stays
the seeded defaults, the byte-identical managed workflow and the AGENTS block,
and `comply`/`verify` remain the whole enforcement loop. Instead
`standards/githooks/pre-commit` is an
optional **reference** hook the consumer owns and opts into (commit it to
their repo, point `core.hooksPath` at it): it runs `defined verify` verbatim.
Deferring to the gate makes it deterministic — same pinned image, SDK and rules
as CI, so a hook can never format to different rules — but it is a full pass
(heavier for dotnet repos), it checks the working tree (not just the index),
and `--no-verify` bypasses it, so it is convenience, not a guarantee.

### Launcher and release identity

- Installable `cli/defined` bash launcher (`#!/usr/bin/env bash`, `[[ ]]`),
  installed on PATH (normally `~/.local/bin/defined`); no gate behaviour; needs
  git + podman/docker; prefers podman; mounts repo read-write for `comply`,
  read-only for `verify`.
- `cli/install.sh` installs it: resolve the revision (the current checkout,
  `--rev <sha>`, or the latest published `main`), download the launcher, verify
  it against a checksum embedded in the installer, install atomically and
  idempotently. The installer and the launcher it ships are a matched pair; a
  test enforces the embedded checksum stays in sync.
- Lifecycle surface: `defined version` — a read-only report of the launcher
  revision, the pin, the image (local/remote), the engine and a drift verdict,
  degrading to "unknown" offline (`--version` is the terse one-liner) — and
  `defined update [<sha>|latest]`, which resolves `latest` to a concrete SHA,
  writes the pin as a working-tree change (never commits), reinstalls the
  launcher at that revision and pulls the exact image. It confirms the image is
  fetchable _before_ writing the pin, so a failed update cannot leave the repo
  pinned to an image that does not exist. `update` refuses the defined source
  repo and needs the network; `comply`/`verify` stay offline-capable.
- `.defined.json` holds the optional immutable image tag under its `version`
  field, plus optional per-ecosystem coverage configuration. An omitted
  `version` (or a missing file) means the current published default image
  (`latest`); a written pin must be immutable — empty, `latest`, malformed or
  conflicting overrides are rejected. Offline runs succeed only with the exact
  image present.
- `runtime/comply.sh` is an internal source-development shim, not a third
  public API; it defaults to the `comply` verb and `--check-only` runs the
  read-only no-fix pass.
- Release identity is immutable and lives in exactly one place — the consumer's
  committed `.defined.json` (decision #36). The managed gate workflow
  (`standards/workflows/defined--verify.yml`, installed by `comply`) carries no
  version: at run time it reads `.defined.json` for the image tag, the same pin
  the local launcher reads.

```text
Git SHA
├── image tag:    ghcr.io/markstanden/defined:<sha>
└── consumer pin: .defined.json "version" → <sha>
```

GitHub forbids an expression in a reusable workflow `uses:` ref, so a
remotely-called workflow would force the consumer to write the gate SHA in YAML
— a second copy that drifts. The managed workflow removes the `uses:` entirely
(the only `uses:` is `actions/checkout`, pinned to a commit hash for zizmor):
the workflow is installed byte-identically by `comply`, so no gate ref is ever
written by hand. Local green = merge green by construction, because there is
nothing to keep in step. An omitted `version` deliberately rides the current
published default image (`latest`) — defaults are obvious, a written pin is the
override that restores immutability.

For the identity to hold, every `main` commit needs an image tag, so
`defined--publish.yml` runs on **every** main push rather than being filtered to
gate-content paths. `defined update latest` resolves `latest` to the merge
commit; an unfiltered publish keeps that SHA pullable. Unchanged layers dedupe,
so re-pushing an identical gate is cheap.

### Consumer configuration

`.defined.json` at the repo root is the single consumer configuration file.
`version` is optional — omitted means the launcher uses the current published
default image; a written pin is immutable (a 7–40 char hex SHA). Optional
`coverage` configuration activates the per-ecosystem coverage gate, an optional
`node` configuration activates consumer Node project checks, and an optional
`naming` configuration supplies consumer naming rules:

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
    "node": {
        "checks": [
            { "name": "lint", "command": "eslint .", "fix": "eslint --fix ." },
            { "name": "typecheck", "command": "tsc --noEmit" },
            { "name": "test", "command": "vitest run" },
        ],
    },
    "naming": {
        "command": "quality/naming.sh",
        "fix": "quality/naming.sh --fix",
    },
}
```

- Absent `coverage` section (or absent ecosystem entry) = that coverage step
  skips.
- `command` is the shell command that generates the coverage report; it runs in
  `fix` mode in the repo, and in `no-fix` mode against the scratch copy of the
  git scope (so a read-only `verify` can still generate and check a report).
- `minimums` per metric are optional; an omitted metric is not checked. When
  the `minimums` key is absent, the step defaults to 80% line coverage.
- The gate parses `node` reports as lcov (`coverage/lcov.info`) and `dotnet`
  reports as Cobertura XML (`coverage.cobertura.xml` or
  `TestResults/coverage.cobertura.xml`).

- Absent `node` section (or an entry with no `checks`) = the `node-checks` step
  skips. The `node-deps` step restores the package's dependencies first
  (`npm ci` / `yarn` / `pnpm` by lockfile, or an explicit `install` command;
  `false` skips restore), and the checks then prepend the package's
  `node_modules/.bin` to `PATH`, so `eslint`/`tsc`/`vitest` resolve to the
  consumer's versions, never the gate's.
- The flat form above targets the sole tracked `package.json` (any depth); set
  `dir` for an explicit package, or use `packages: [{ dir, install, checks }]`
  for a monorepo. A per-check `fix` command runs first in `comply` only, then
  the check always re-runs before reporting.
- The `naming` step always enforces the workflow-filename grammar over tracked
  `.github/workflows/*.yml|yaml` files (see `standards/naming.md`). An optional
  `naming` section adds the consumer's own rules: `command` runs over the git
  scope and must exit non-zero on violations; `fix` runs first in `comply` only,
  then `command` always re-runs. Absent `naming` = grammar only.

### Bootstrap contract

`comply` bootstraps a consumer repo from the image-baked versions under
`standards/` and seeds a marker-delimited block in `AGENTS.md` idempotently
without clobbering project content. Shared files come in two tiers:

- **Seeded defaults** — `.editorconfig`, `Directory.Build.props`,
  `.gitattributes`. Installed only when absent: a repo with its own rules keeps
  them, so the gate never overwrites and `verify` never gates on them. House
  style is a default, not a mandate.
- **Managed** — the gate workflow at `.github/workflows/defined--verify.yml`.
  Byte-identical to the image: `comply` overwrites a differing copy so a gate
  update propagates, and `verify` fails on drift (it is read-only). There is no
  semantic merge.

Sources live under `standards/` and targets under the repo root; the two differ
only for the workflow, which lives at `standards/workflows/` but installs into
`.github/workflows/`.

The seeded `.gitattributes` pins the checkout line-ending contract
(`* text=auto eol=lf whitespace=trailing-space,space-before-tab,cr-at-eol` plus
binary rules), so it agrees with the seeded `.editorconfig`'s
`end_of_line = lf` and with `git diff --check`, locally and in CI.

The seeded `.editorconfig` carries a test-code policy under the convention
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
│   ├── defined                       # installed host launcher; no gate logic
│   └── install.sh                    # verified, idempotent installer
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
│   └── workflows/defined--verify.yml # managed gate workflow (installed by setup)
├── practices/                        # explanatory guidance
└── .github/workflows/
    ├── defined--verify.yml           # installed copy of the managed workflow
    ├── defined--test.yml             # this repo's CI
    └── defined--publish.yml          # image publication
```

The producer repo commits a versionless `.defined.json` — a coverage-only
config (a self-referential `version` pin is impossible by construction, and an
omitted version means the default image, which the source-development shim
never consults anyway). `comply` on this repo is the coverage gate it ships,
self-hosted on the gate's own test suite.

## Open gaps (backlog)

The gate is complete enough to adopt in parallel; there are currently no filed
capability gaps. This table is the plan-of-record entry point so a fresh session
knows what is left without trawling the issue list.

| #   | Gap        | Blocks |
| --- | ---------- | ------ |
| —   | none filed | —      |

Recently delivered (so the list above is not re-litigated): #19 (`node-checks`
runs the consumer's declared ESLint/`tsc`/tests), #20 (`node-coverage` generates
its report in the no-fix scratch), #21 (node checks use the consumer's own
toolchain and nested package locations), #22 (`yamllint -s` — warnings fail),
#23 (zizmor at its own default severity), #24 (the `workflow` step honours the
consumer's `.gitleaksignore` baseline), #25 (the `naming` step enforces the
workflow-filename grammar and runs consumer-declared rules), #26 (general naming
doctrine lives in `standards/naming.md` + `standards/naming/`), #27
(consumer-owned prettier config wins), #28 (`.gitattributes` is managed), #35
(the launcher gains `version`/`update` and a verified `cli/install.sh`), #40
(`node-deps` restores consumer dependencies before formatting, so a
config-declared Prettier plugin resolves on a fresh checkout).

Both previously unfiled items are now delivered:

- Launcher offline mode — `DEFINED_OFFLINE=1` runs the container with
  `--network=none`, avoiding podman's pasta backend on hosts without the `tun`
  module. The image must already be present locally; dependency restore then
  uses the named volumes' cache.
- Managed-file drift now fails `comply` through the report contract
  (`not compliant after repair` + `fail bootstrap — …`), never a raw Node
  stack.
