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

## Structure

- **Flat over nested**: `runtime/`, `lib/`, `standards/`, `practices/`.
  Modules named by what they do.
- **Filename == purpose**: `runtime/steps/<id>.mts`; the file names the step.

## Code

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
