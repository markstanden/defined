# AGENTS.md

## What this repo is

A source of truth for **other projects'** configuration, delivered as one
container image — the `defined` gate. There is no application here: no solution,
no `package.json`. Verification is the gate's own suite (`node --test`) plus the
podman end-to-end gate; the gate is tested on the gate.

Where to look:

- **Consuming or adopting the gate** — [`README.md`](README.md): the contract,
  and the single home of the `.defined.json` examples.
- **House doctrine** — [`standards/`](standards/): naming, shell, YAML, tests.
  Read the relevant file when a task touches that area.
- **Working-style preferences** —
  [`practices/architecture.md`](practices/architecture.md).
- **History** — [`records/`](records/): session records, not guidance.

## Non-obvious structure

- `cli/defined` is the installed host launcher — bash, needs only git +
  podman/docker, carries no gate behaviour. `cli/install.sh` embeds its
  `LAUNCHER_SHA256`, so editing the launcher means updating the checksum (a test
  enforces the pair). Both are tested with fake engines/git/curl injected on
  `PATH`, so no real engine or network is needed.
- `standards/workflows/defined--verify.yml` is the single source of truth for
  the managed gate workflow; `.github/workflows/defined--verify.yml` here is the
  installed copy. Its job skips this repo (the guard excludes
  `markstanden/defined`) because the baked standards would false-fail against a
  working tree mid-change — `defined--test.yml` covers this repo instead.
- `defined--publish.yml` builds and pushes the image on **every** main push, so
  every main commit carries a pullable tag; `defined--test.yml` runs the unit
  and broken-fixture suites plus the self-host gate.

## Working here

- Keep it green on both levels: `node --test` **and** `./runtime/comply.sh` (the
  internal source-development shim; `--check-only` is its read-only pass).
  Host-green does not mean gate-green.
- `runtime/` and shared `lib/` are TypeScript on Node strip-types; the module
  conventions are law in
  [`standards/testing/node-testing.md`](standards/testing/node-testing.md).
- The block below is **managed**: edit its source,
  [`runtime/config/agents-block.md`](runtime/config/agents-block.md), never the
  copy here. It is baked into the image, so a wording change reaches consumers
  on the next release.

<!-- defined:start -->

This project is gated by Mark's portable defined gate. Run `defined comply` —
bootstrap, repair and verify in one pass; use it every time. (`defined verify`
is the pipeline-only read-only check.) A missing ecosystem skips, a missing
tool fails loudly.

House standards live in the defined repo
(<https://github.com/markstanden/defined>): `standards/` covers tests, naming,
shell and YAML; `practices/architecture.md` covers delivery, structure and
working style. Read the relevant file when a task touches that area. Tighten the
floor; don't fork it — raise improvements upstream.
<!-- defined:end -->
