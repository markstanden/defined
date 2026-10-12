---
Area: decisions
Keywords: eslint, naming-convention, typescript-eslint recommended, floor tightening, consumer rollout, oracle
Summary: Ported the typescript-eslint recommended set and naming-convention into the baked house ESLint floor — the door opt-outs, the oracle findings, and the consumer sweep.
---

# Tightening the ESLint floor: recommended set and naming-convention

The baked house ESLint floor gained the typescript-eslint recommended set and
the naming-convention rule (2026-10-12), ported from
`markstanden/opencode-docs-plugin`'s repo config so a repo like it can drop its
own `eslint.config.*`. It is a deliberate tightening of the one floor, not a
versioned release: a rule that flags conforming code is a defect to fix, not a
floor to hold back.

## Facts

- `runtime/config/eslint.config.mjs` now spreads `tseslint.configs.recommended`
  and adds `@typescript-eslint/naming-convention`; `eslint-config-prettier`
  stays last.
- Pins in `runtime/tool-versions.env`: ESLint 10.12.0, typescript-eslint 8.71.1,
  eslint-plugin-jsdoc 65.3.0. The parser stays 6.0.3 — typescript-eslint 8.x
  peers `typescript <6.1.0`. Image tag `152443f4c4e3` (that file's content hash).
- Two `.defined.json` doors gate the additions: `eslint.recommended: false`
  forwards `DEFINED_ESLINT_RECOMMENDED=off`; the naming rule has no door.
  `complexityMax` and `requireJsdoc` are unchanged.
- Oracle-verified on the pinned versions: the reference selectors alone flag
  every PascalCase import, so an `import` selector (camelCase, PascalCase) is
  required; `requiresQuotes` must be repeated per key-bearing selector
  (`property`, `objectLiteralProperty`, `objectLiteralMethod`);
  `**/*.d.ts` and `*.config.{mjs,ts,mts}` are naming-exempt; the recommended
  `no-unused-vars` is overridden with `^_`-prefix ignore patterns.
- Consumers on this machine (a `.defined.json` each): `defined`,
  `system-config`, `rdd-astro`, `energy-comparison` (no JS/TS, step skips) and
  `opencode-docs-plugin` (owns a config). Against the new floor: `defined` is
  clean after three unused-var fixes; `system-config` has six
  `no-explicit-any`; `rdd-astro` has one `GET`; `opencode-docs-plugin` has four
  pre-existing findings (three `regexp/no-super-linear-move`, one
  `jsdoc/require-jsdoc`) that surface only once its config is deleted.

## Inferred

- `rdd-astro`'s `GET` is Astro's mandated endpoint export, not a naming
  defect; it needs a local disable rather than a rename.
- `system-config`'s `any`s sit in an OpenCode plugin's hook types; replacing
  them with `unknown` or a concrete event type is repo design work, not a gate
  change.

## Tested

- `./runtime/comply.sh --check-only` and `./runtime/comply.sh` both report
  `compliant` on this repo.
- `node --test` over the repo: 506 pass, including the in-container fixture e2e.

## Open questions

- Do the consumer follow-ups (system-config `any`s, rdd-astro `GET`,
  opencode-docs-plugin's four findings) land as one PR per repo?
