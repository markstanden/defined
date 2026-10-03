# Project brief

Portable quality gate: one container image (the "defined gate") that detects a
repo's stack and runs house checks. Source repo has no application code —
verification is the gate's own suite plus the self-host gate.

## Verified commands

- `node --test` — full unit suite; 443 pass on 2026-10-03 (fixture e2e inside
  it skips cleanly without podman).
- `node --test runtime/fixture.test.mts` — the real-container e2e: builds/drives
  the gate image over a generated broken repo; needs podman or docker.
- `./runtime/comply.sh` — the gate on itself (`defined comply` equivalent for
  gate development). `--check-only` is the read-only pass. Both print one JSON
  result line. Tool-pin changes rebuild the image automatically.
- TypeScript typecheck runs in-image (global `tsc`); the host has no tsc.

## Layout

- `runtime/steps/<id>.mts` — one module per run-plan step; runners are injected
  so step tests use fakes from `runtime/test-helpers.mts` (test-only module).
- `runtime/config/` — baked consumer-facing configs (`eslint.config.mjs`,
  `prettier.config.mjs`); plugins must install under the `/opt/defined` prefix.
- `runtime/lib/` gate internals, `lib/` shared host modules, `cli/` launcher.
- `runtime/tool-versions.env` — the single pin source; its sha256 (first 12) IS
  the local image tag and the published tag.
- `standards/` — seeded consumer defaults + house doctrine (consumers own their
  seeded copies after install; managed files get restored by comply).
- `docs/plans/PLAN_*.md` — session plans; gitignored via `.git/info/exclude`
  (pattern `PLAN_*.md`), never committed.

## Traps

- ESLint flat config silently ignores files outside the eslint process CWD's
  base path: running the house config from a foreign cwd returns `[]` with
  rc 0 and no diagnostics. Always set cwd to the repo root. (Bit the docblock
  compliance sweep 2026-10-03 — false zero.)
- In-memory `Linter.verify` needs a `files` match in the config object or it
  reports "No matching configuration found".
- `dotnet format --verify-no-changes` on a project whose build fails reports
  the BUILD errors; the dotnet step's "format found diffs" notice can mean a
  build failure (e.g. CS1591), not formatting.
- jsdoc plugin (v65) quirks behind the documentation floor: see
  `mem:plans/public-api-docblock-floor`.

## Open problem

Branch `tights-api-docblocks` is review-green (all suites + self-host gate);
next: push/PR, then release notes for pinned consumers (what `defined update`
tightens) and the StyleCop packaging spike. Details in the deep-dive doc.

## Deep dives

- `mem:plans/public-api-docblock-floor` — public-API docblock floor:
  docs/plans/public-api-docblock-floor.md
