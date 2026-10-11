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
- **Knowledge** — [`docs/`](docs/): the brief, area deep dives, decisions and
  issue analyses; [`docs/plans/`](docs/plans/) is scratch.

## Non-obvious structure

- `cli/defined` is the installed host launcher — bash, needs only git +
  podman/docker, carries no gate behaviour. `cli/install.sh` embeds its
  `LAUNCHER_SHA256`, so editing the launcher means updating the checksum (a test
  enforces the pair). Both are tested with fake engines/git/curl injected on
  `PATH`, so no real engine or network is needed.
  **Tag workflow:** a main push republishes `:latest` and the 12-char SHA tag;
  existing pinned consumers are unaffected until they run `defined update`, so
  tagging a release is simply `gh release create <sha12>` after the image lands.
- Commit messages are subject-only (`adds X`, `fixes Y`) and the default
  verbosity is concise: `comply`/`verify` print one compact JSON line —
  `status` plus any `errors` — and `--full` adds the per-check `results` map
  (worth one contextual run, noise thereafter). Use `--full` when you need the
  plan; leave it off otherwise.
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
bootstrap, repair and verify in one pass. (`defined verify` is the
pipeline-only read-only check.) A missing ecosystem skips; a missing tool
fails loudly.

**When to run it.** After a coherent set of edits, before committing or
handing work back. One run after a batch beats one per file.

**Reading the result.** Both verbs print one compact JSON line: `status` and
actionable `errors` — read the errors instead of re-running tools by hand;
`--full` adds the per-check `results` map on a first, contextual run.

**After a run.** `git diff`: repairs are real edits to your tree. Fix
findings, then rerun — do not repeat an unchanged failing command. If a check
could not run at all, report the failing step and its error rather than
retrying it as-is. Do not weaken or disable a check just to get green — fix
the finding or raise it upstream.

**What the gate owns.** Bootstrap seeds house defaults (`.editorconfig`,
`.gitattributes`, `Directory.Build.props`) that this project then owns, and
manages plumbing (the CI workflow and this block), realigned on each run.
Edit the seeded defaults here as you wish; raise changes to managed files and
house standards upstream — never fork them locally.

**Public APIs are documented.** Doc comments carry purpose, parameters,
returns, constraints — never name-restating filler; small, well-named private
helpers need no block. The gate proves the sections exist; reviewers prove
the words match (`defined explain jsdoc/require-jsdoc`).

**Knowledge is documented.** Sectioned docs under `docs/`:
`Area`/`Keywords`/`Summary` front-matter, `Date` derived from git, claims
grouped Facts / Inferred / Tested / Open questions. Convention and scrub
checklist: `standards/documentation.md`.

**Looking things up.** `defined explain <step-or-rule>` serves house guidance
from the pinned image — offline, no repo writes, matched to the revision that
gates you; prefer it over reading the upstream repository. House standards:
`standards/` (tests, naming, API documentation, shell, YAML) and
`practices/architecture.md`. Tighten the floor; don't fork it.
<!-- defined:end -->
