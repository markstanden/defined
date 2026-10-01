# House ESLint

The gate lints a repo's git-scoped JS/TS with ESLint 10 (flat config) as a
first-class step, so linting is batteries-included rather than re-solved per
repo.

## What the gate owns

- The **config** and its **plugins** live in the image
  (`runtime/config/eslint.config.mjs`); the gate never edits a consumer's
  `package.json`.
- With no `eslint.config.*` at the repo root the baked house config runs (via
  `--config`), and its plugins resolve in-image.
- A repo-owned `eslint.config.*` at the root runs instead (through the repo's
  restored ESLint), so its own deps and version resolve. The gate writes
  `eslint.config.defined.mjs` beside it as an example of the current default and
  adds it to `.git/info/exclude`.
- `"eslint": { "disable": true }` in `.defined.json` turns the step off;
  `"eslint": { "complexityMax": N | false }` tunes the complexity ceiling
  below (house config only — a repo-owned config governs itself).

The step runs after `node` and before `node-checks`; `comply` runs `--fix` then
always re-checks, `verify` never writes.

## v1 rule set

Deliberately narrow, so a pin bump cannot fail every consumer at once:

- `regexp/no-super-linear-backtracking` and `regexp/no-super-linear-move` — the
  super-linear-regex floor (the local reproduction of Sonar
  `typescript:S8786`);
- `complexity` max **10** per function (2026-10-01) — deliberately tighter than
  Sonar's cognitive-complexity 15, so a branchy function is named with its
  score at review time rather than at the next Sonar scan. Test files
  (`*.test.*`, `*.spec.*`) are exempt: a linear test script is not a design
  smell, and Sonar does not gate test code either. Per-repo tunable:
  `"eslint": { "complexityMax": 12 }` raises it, `false` drops the rule; the
  step forwards the value to the baked config as
  `DEFINED_ESLINT_COMPLEXITY_MAX`;
- `eslint-config-prettier` last, so ESLint never votes on formatting.

## Adding a rule (v1 → v2 growth plan)

Append to the `rules` block in `runtime/config/eslint.config.mjs`, dated, once
the repos that will run it are clean. `@eslint/js` and the `typescript-eslint`
recommended sets are the intended v2 additions; typed rules wait until then.
Bump the ESLint pins in `runtime/tool-versions.env` in the same change that uses
them — the image tag is the content hash of that file, so a pin change rebuilds.

## Why baked, not seeded

A config in the repo would resolve its plugins from the repo, forcing them into
the consumer's `package.json`. Baked keeps the deps in the image; tailoring is
opt-in by bringing your own config and deps.
