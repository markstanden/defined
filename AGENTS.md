# AGENTS.md

## What this repo is

A source of truth for **other projects'** configuration, delivered as one
container image (`defined`, built from `runtime/` + shared `lib/` +
`standards/`). There is no application here: no solution, no `package.json`.
Verification is the gate's own suite (`node --test`) plus the podman
end-to-end gate.

## Non-obvious structure

- `cli/defined` is the **installed host launcher** (decision #25): bash, no gate
  behaviour, needs only git + podman/docker. It reads the consumer's committed
  `.defined.json` `version` (omitted → current published default image; a
  written pin is immutable), prefers podman, mounts the repo rw for `comply` / ro
  for `verify`. Its lifecycle surface is `defined version` (read-only report:
  launcher, pin, image, engine, drift; `--version` is the terse one-liner) and
  `defined update [<sha>|latest]` (resolve `latest` to a concrete SHA, write the
  pin as a working-tree change, reinstall the launcher at that revision, pull the
  exact image; refuses the source repo). `cli/install.sh` is the verified,
  idempotent installer `update` reuses — its embedded `LAUNCHER_SHA256` must track
  `cli/defined` (a test enforces it). Tested via `cli/defined.test.mts` and
  `cli/install.test.mts` with fake engines/git/curl injected on PATH (no real
  engine or network needed). The producer repo commits its own versionless
  config — a coverage-only `.defined.json`.
- Root `.github/workflows/*.yml` hold one managed gate workflow and two
  repository CI workflows. `defined--verify.yml` is the managed gate workflow:
  it is installed into consumer repos by `comply` (see below), carries its own
  name-agnostic triggers, and reads the gate version from the consumer's
  `.defined.json` — it is **not** a reusable workflow, so no consumer pins a
  gate ref. Naming convention: `<namespace>--<loose-verb>[--<target>].yml`
  (double hyphen separates the segments; the verb names the intent, not the tool
  — see `standards/naming.md`). The other two ARE CI for this repo:
  `defined--publish.yml` (builds + pushes the gate image to ghcr on **every**
  main push — deliberately unfiltered, so every main SHA carries an image tag
  and `defined update latest` can pin it — tagged with the tool-pin hash, short
  SHA and `latest`) and `defined--test.yml`
  (runs the gate's own unit + broken-fixture suite, the self-host gate with
  coverage, and a guarded SonarQube scan on PRs and merges).
- `standards/workflows/defined--verify.yml` is the single source of truth for
  the managed gate workflow; `.github/workflows/defined--verify.yml` here is the
  installed copy. Its job skips this repo — the guard excludes
  `markstanden/defined` — because the published image would compare its baked
  standards against the working tree and false-fail on any managed-file change;
  `defined--test.yml` covers this repo instead.
- `standards/.editorconfig`, `standards/Directory.Build.props`,
  `standards/.gitattributes` and `standards/workflows/defined--verify.yml` are
  the single source of truth for shared files — `comply`'s bootstrap installs
  them into consumer repos from the baked image. The repo's own root
  `.editorconfig`, `Directory.Build.props`, `.gitattributes` and
  `.github/workflows/defined--verify.yml` are copies of the `standards/`
  versions (self-hosted: `comply` on this repo bootstraps nothing beyond the
  AGENTS block but runs the coverage gate on its own tests). The three config
  files are **seeded defaults** — installed only when absent, so a repo with
  its own rules keeps them; the gate workflow is **managed** — `comply` brings a
  differing copy back to the image's and `verify` fails on drift (there is no
  semantic merge). `.editorconfig` drives prettier (pure-defaults config reads
  it natively), shfmt and IDEs from one source; `.gitattributes` pins the
  matching LF/whitespace checkout contract.

## The gate: how it works

`runtime/` + shared `lib/` are built per `PLAN.md` (the working, living plan of
record — read it before touching anything gate-related):

- Container-native runtime (official `node:<ver>-slim` base, digest-pinned
  via `tool-versions.env`); host surface is the installed `cli/defined`
  launcher (git + podman/docker plus standard coreutils) and the internal
  `runtime/comply.sh` source-development shim.
- TypeScript core, Node ≥26 strip-types: **no enums/namespaces** (bare string
  literal unions), extensioned imports, zero dependencies, tested with
  `node --test` colocated as `*.test.mts`.
- Steps run in fixed order `naming → node-deps → node → node-checks →
node-coverage → dotnet → dotnet-coverage → shell → smoke → yaml → workflow →
tofu`; missing applicable tools fail loudly pointing at the Containerfile (no
  optional tier). Coverage steps activate on a `.defined.json` `coverage` entry;
  `node-checks` activates on a `node` entry (see `runtime/lib/config.mts`);
  `node-deps` restores the consumer's dependencies (declared packages, plus the
  root package when a consumer Prettier config is tracked) before the node
  family runs.
- **Use the gate, not ad-hoc formatting**: after a change lands, run
  `./runtime/comply.sh` with no flags — **one command, one output**. It bootstraps,
  repairs (formats, fixes safe findings) and then runs a fresh verify, printing a
  single `compliant`/`not compliant` verdict. Don't hand-invoke prettier or add a
  `--check-only` step yourself to "check first"; plain `comply` is the whole loop.
  Keep it green continuously: `node --test` _and_ the podman end-to-end gate
  (`./runtime/comply.sh`) — host-green does not mean gate-green. `node --test`
  also runs the broken-fixture integration test (`runtime/fixture.test.mts`),
  which drives the real gate against a deliberately-broken repo and skips
  cleanly without a container engine. Keeping the gate green is the tripwire —
  any workflow-template deviation fails the `workflow` step again.
- The image tag IS the toolchain — the gate image carries every pinned tool, so
  containerised CI jobs need no setup-opentofu/setup-dotnet/setup-node steps.

## Conventions

- Shell scripts follow [`standards/shell.md`](standards/shell.md) — bash
  shebang, `[[ ]]`, explicit `return` (shellcheck-enforced).

<!-- defined:start -->

This project is gated by Mark's portable defined gate. Run `defined comply` —
bootstrap, repair and verify in one pass; use it every time. (`defined verify`
is the pipeline-only read-only check.) A missing ecosystem skips, a missing
tool fails loudly.

House standards live in the defined repo
(<https://github.com/markstanden/defined>): `standards/` covers tests, naming,
shell and YAML; `practices/` covers architecture and working style. Read the
relevant file when a task touches that area. Tighten the floor; don't fork it —
raise improvements upstream.
<!-- defined:end -->
