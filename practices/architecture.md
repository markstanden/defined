# Architecture preferences

Working principles for how I design and structure projects. These are
preferences, recorded so agents and reviewers apply them consistently — the
hard rules (gate steps, module conventions, naming) live in `standards/` and
are enforced by the gate.

## Working style

- **Small everything**: small commits, small functions and methods, small
  files. One change per commit, verification green at every step.
- **Tight, predefined contracts**: settle the interface before the body; keep
  the surface minimal and explicit.
- **Failing test first**: write the failing test, then the smallest change that
  passes it; table-test the boundaries.
- **Small pure functions**: extract pure logic and inject the effects, so a
  function reads as one idea.
- **Gate-clean commits**: every commit passes `defined comply` on its own — no
  "fix the gate later" debt.

## Guidance ownership

- **A rule lives at the lowest rung that holds it**: compiler/analyser first
  (decidable, total, free), the `defined` gate second (deterministic, every run,
  one verdict), tests third (semantic claims only behaviour can settle), skills
  and standards prose fourth (judgement, advisory), knowledge docs last (the
  reasoning). A decidable rule written in prose is obeyed inconsistently — an
  observed rate of roughly half in one measured campaign — and every miss costs
  a write→review→fix circle; a judgement call pushed into the gate becomes noise
  or gets gamed. Expect rules to migrate downward as machinery arrives.
- **Worked examples**: a banned symbol (wall-clock time, ambient randomness) is
  an analyser rule with a banned-symbols list; layering (core references no I/O
  or vendor SDKs) is an architecture-test project; command/query separation,
  injectable effects and pure cores stay prose here, made to bite by the
  analyser that bans the shortcut.

## Delivery

- **One container image is the toolchain.** Pin versions in one place
  (`tool-versions.env`); the image tag IS the release. No per-distro installer
  scripts, no drift between environments.
- **Local green = merge green.** CI runs the same image as the developer,
  because the installed workflow reads the `.defined.json` pin; nothing is
  environment-specific and no gate ref is duplicated in YAML.
- **Two distribution channels only**: the pinned image and the shared files it
  installs (the gate workflow included). No submodules, no symlinks, no consumer
  application artifacts (the gate image itself is, of course, a release
  artifact).
- **One gate workflow**: `defined--verify.yml` is the sole consumer-facing gate
  workflow, installed as a managed file. Delivery actions live in the consumer's
  own pipelines.
- **Plugin-free by default**: the gate bakes no ecosystem-specific plugins, and
  its baked prettier config carries none at all. New capability arrives as
  consumer-declared tasks in `.defined.json`, run _alongside_ the house steps, so
  an extension never has to replace the floor. A real consumer need reopens a
  bake deliberately; the default is to extend, not to bake.

## Structure

- **Flat over nested**: `runtime/`, `lib/`, `standards/`, `practices/`.
  Modules named by what they do.
- **Filename == purpose**: `runtime/steps/<id>.mts`; the file names the step.

## Code

- **Functional core, imperative shell**: keep decisions as pure functions and
  inject the effects (time, IO, randomness, network) at the edges. A command
  mutates and returns nothing meaningful; a query answers and never mutates
  (CQS) — a method that does both hides its cost at every call site. Time comes
  from an injected `TimeProvider`, never `DateTime.UtcNow`; the banned-symbols
  list makes that mechanical.
- **Laws earn generated tests**: round-trip, idempotence, ordering and
  normalisation laws derive their generators from the documented domain and pin
  the seed; named examples stay for the cases the law cannot name.
- **TypeScript core, strip-types runtime**: no enums/namespaces, extensioned
  imports, zero dependencies. The host launcher is a thin bash shim and the
  source shim stays thin too.
- **Testability by injection**: anything that shells out accepts a runner
  parameter; pure logic is extracted and table-tested.
- **Floors are exact**: the managed gate workflow must stay byte-identical to
  the image-baked version (drift fails `verify`; `comply` updates it). Shared
  configs that express house style (`.editorconfig`, `Directory.Build.props`,
  `.gitattributes`) are seeded defaults: installed only when absent, so a repo's
  own rules win. Extension happens through project-level files, not by editing
  the managed floor. `comply` may apply repairs that modify the working tree —
  those changes are reviewable, and each tool must pass its own subsequent
  check in the mandatory second verify pass.

## Tools

- **No optional tier**: a tool the image should contain must exist; its
  absence is a Containerfile problem, not a soft skip.
- **Config owns style**: edit config and run `comply`, never hand-tune
  generated output.
