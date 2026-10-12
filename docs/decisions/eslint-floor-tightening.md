---
Area: decisions
Keywords: eslint, @eslint/js, typescript-eslint recommended, naming-convention, globals.node, floor tightening, consumer sweep, oracle
Summary: Grew the baked house ESLint floor with the core @eslint/js and typescript-eslint recommended sets, naming-convention, and a Node globals map — the door opt-out, oracle findings and consumer sweep.
---

# Tightening the ESLint floor: recommended sets, naming and Node globals

The baked house ESLint floor gained the core `@eslint/js` and typescript-eslint
recommended sets, the `@typescript-eslint/naming-convention` rule and a Node
globals map (2026-10-12), largely ported from `markstanden/opencode-docs-plugin`'s
repo config so a repo like it can drop its own `eslint.config.*`. It is a
deliberate tightening of the one floor, not a versioned release: a rule that
flags conforming code is a defect to fix, not a floor to hold back.

## Facts

- `runtime/config/eslint.config.mjs` spreads `js.configs.recommended` then
  `tseslint.configs.recommended`, sets `languageOptions.globals` to
  `globals.node`, and adds `@typescript-eslint/naming-convention`;
  `eslint-config-prettier` stays last.
- Pins in `runtime/tool-versions.env`: ESLint 10.12.0, typescript-eslint 8.71.1,
  eslint-plugin-jsdoc 65.3.0, `@eslint/js` 10.0.1, `globals` 17.13.0. The parser
  stays 6.0.3 — typescript-eslint 8.x peers `typescript <6.1.0`. ESLint 10 no
  longer bundles `@eslint/js` (the `eslint/js` subpath export is gone), so it is
  its own pin.
- One door: `"eslint": { "recommended": false }` drops both recommended sets
  (forwarded as `DEFINED_ESLINT_RECOMMENDED=off`); the naming rule has no door.
  `complexityMax` and `requireJsdoc` are unchanged.
- Oracle-verified on the pinned versions:
    - the reference naming selectors alone flag every PascalCase import, so an
      `import` selector (camelCase, PascalCase) is required; `requiresQuotes` must
      be repeated per key-bearing selector; `**/*.d.ts` and
      `*.config.{mjs,ts,mts}` are naming-exempt; `no-unused-vars` overrides the
      `^_` prefix;
    - core `no-undef` needs the Node globals map: on JS it fires for
      `process`/`console`/`module` (typescript-eslint leaves `no-undef` on for JS,
      off for TS where the compiler checks);
    - the core set adds nothing else across the house repos and the fixture except
      `no-useless-escape` (a redundant `\[` inside a character class).
- Consumers (a `.defined.json` each): `defined` is clean; `energy-comparison`
  skips (no JS/TS); `system-config` has six `no-explicit-any` and one
  `no-useless-escape`; `rdd-astro` has one `GET` (Astro's mandated endpoint);
  `opencode-docs-plugin` owns a config (four pre-existing findings surface once
  its config is deleted). The genuine consumer findings are separate follow-ups.

## Inferred

- `rdd-astro`'s `GET` is a framework contract, not a naming defect: a local
  disable, not a rename.
- `system-config`'s `any`s sit in an OpenCode plugin's hook types; replacing
  them with `unknown` or a concrete type is repo work, not a gate change.

## Tested

- `./runtime/comply.sh` (`--check-only` and full) reports `compliant` on this
  repo; `node --test` passes, including the in-container fixture e2e.
- The fixture's semantic-repair regex moved from `[^\[\]]` to `[^[\]]`, the
  spelling the core `no-useless-escape` rule accepts; the deliberately broken
  `[^\]]` spelling still trips `regexp/no-super-linear-move`.

## Open questions

- Do the consumer follow-ups (system-config, rdd-astro, opencode-docs-plugin)
  land as one PR per repo?
