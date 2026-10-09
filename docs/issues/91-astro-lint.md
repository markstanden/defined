---
Area: issues
Keywords: astro, eslint, lint, issue 91, plugin-free, superseded, consumer task
Summary: Superseded plan for linting `.astro` files in the eslint step — the bake was rejected; Astro linting arrives as a consumer task.
---

# PLAN: lint `.astro` files in the eslint step (#91)

**Status:** superseded — kept as history; the GitHub issue remains open. The
bake this plan proposed was rejected; the outcome is recorded in
[`plugin-free-and-consumer-extensions.md`](../decisions/plugin-free-and-consumer-extensions.md):
no astro bake, Astro linting arrives as a consumer task (or a repo-owned config
today).
**Issue:** #91 — open; the design resolves as "no bake". Proving ground:
`markstanden/rdd-astro`.

## 1. The idea

Bake Astro support into the house ESLint config so an Astro repo gets Astro
linting **and** the house floor (complexity, JSDoc, super-linear regex) with no
repo-root `eslint.config.*`. Today the two are mutually exclusive: a repo
config replaces the floor entirely.

House precedent (ESLint plan decision 1, `PLAN_bootstrap-example-files.md` §8):
the gate owns the ESLint config **and its plugins**, and never edits a
consumer's `package.json`. Baking in is that pattern applied once more.

Rejected — the compose option (issue ask 2): a repo config importing the baked
config needs a stable import path into `/opt/defined`, which the repo tree
cannot resolve (deps sit outside it, and `node-deps` restore only restores the
repo's own deps). Any bridge is new surface for one consumer. A repo config
still replaces the floor wholesale — that trade stays documented, not engineered
around.

## 2. Changes

| file                               | change                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `runtime/tool-versions.env`        | add `ESLINT_PLUGIN_ASTRO_VERSION` pin                                                                       |
| `runtime/Containerfile`            | add `eslint-plugin-astro@…` to the `/opt/defined` install + version assertion                               |
| `runtime/config/eslint.config.mjs` | import astro plugin; new config object for `**/*.astro` (parser + curated rules); header dates the addition |
| `runtime/steps/eslint.mts`         | `ESLINT_EXTENSIONS` gains `"astro"` (mirrors the config)                                                    |
| `standards/node-eslint.md`         | document the `.astro` surface: what runs, what the parser covers                                            |
| tests                              | `runtime/steps/eslint.test.mts` + `runtime/lib/eslint-config.test.mts` cases                                |

No explain change: the eslint step already maps to `node-eslint.md`; the doc
content carries the new surface.

## 3. Config shape

Keep the floor scoped to today's eight extensions. `.astro` gets its own
object:

```js
{ files: ["**/*.astro"],
  plugins: { astro },
  languageOptions: { parser: astro.parser },
  rules: { /* curated astro rules, dated */ } }
```

Why not add `.astro` to `LINT_FILES`: the floor's JSDoc contexts
(`MethodDefinition`, `TSPropertySignature`, …) are tuned for the
typescript-eslint AST; the astro parser's frontmatter wrapper may attach them
differently, and a floor that silently misses (or false-fires) on frontmatter is
worse than an explicitly scoped one. The astro object still parses frontmatter
as TS, so `astro/*` rules see the script.

`filterEslintFiles` sends `.astro` paths to ESLint; repos without `.astro`
files see zero change (the filter drops them before ESLint runs).

## 4. Rule appetite [NEEDS DECISION]

- **A. Parser + validity rules only (recommended):** the plugin's ⭐ "Possible
  Errors" set (`missing-client-only-directive-value`, `no-conflict-set-directives`,
  the `no-deprecated-*` family, `no-exports-from-components`,
  `no-prerender-export-outside-pages`, `no-unused-define-vars-in-style`) plus
  the two security rules (`no-set-html-directive`, `no-unsafe-inline-scripts`).
  Not `astro/valid-compile` or `no-omitted-end-tags` — both deprecated, no
  replacement (plugin docs, checked 2026-10-04). Matches "add rules as they
  earn their place".
- **B. `astro/recommended` wholesale:** more signal, but a pin bump can turn
  every Astro consumer red at once — exactly what config v1 defers.

**Autofix policy (either appetite): bake no 🔧 rule — priced, not banned.** The
gate's selling point is CPU over LLM tokens: every finding a fixer repairs is
tokens an agent never spends, so fixers are welcome where reliable (prettier is
the biggest one the gate runs). Refused only where failure costs more tokens
than the fix saves. The astro 🔧 rules fail both ways: the stylistic ones
(`sort-attributes`, the `prefer-*` set, `astro/semi`,
`no-deprecated-astro-fetchcontent`) duplicate prettier-plugin-astro's
already-CPU formatting; the semantic rewriters (`no-set-text-directive`) edit
template text against the virtual source `astro-eslint-parser` synthesises
(fences hidden) — a drifted fix produces markup that still lints clean, which
the authoritative no-fix pass cannot catch, and debugging that costs more
tokens than the fix ever saved. Practical constraint too: ESLint has no
per-rule fixer switch (`enableFixer` is a jsdoc-plugin option astro's plugin
lacks), so rule selection is the only lever. Select rules by remediation type:
information-free transformation (formatting, sorting, mechanical renames) —
autofix on CPU, the turn disappears; durable-information creation (docs) —
detect on CPU, the agent reasons once and the artefact serves review and LLM
discovery forever (stubs are banned because they simulate the artefact without
the reasoning that gives it value); semantic judgement (a11y, conflicts) —
detect only. The unit of economy is the turn: defined collapses
run-read-fix-rerun into one CPU pass, and every reliable fixer deletes a turn
outright. Priced per fixer, the astro 🔧 set provides ~nothing: `astro/semi`
duplicates prettier-plugin-astro's frontmatter formatting; `sort-attributes`
and the `prefer-*` class:list rewrites are un-adopted taste — churn at pin
bump, no turn deleted (`sort-attributes` is the one fixer prettier cannot
replace: core prettier preserves attribute order by design and
prettier-plugin-astro does not sort — but non-redundant is not valuable, the
preference manufactures the churn it then fixes); `no-set-text-directive`
targets a directive Astro's docs call uncommon; `no-deprecated-astro-fetchcontent` fires only on Astro ≤2
(API removed in v3, 2023) and rewrites to `Astro.glob()`, itself deprecated —
the turn it would delete never happens. Every astro rule worth detecting is
unfixable by design: the fix is a decision, not a transformation.

Either way: the floor (complexity/JSDoc/regexp) does **not** extend to
frontmatter in this change (§3). Revisit only if review shows frontmatter
complexity mattering.

## 5. Risks

| risk                                                     | mitigation                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint-plugin-astro` peer range excludes ESLint 10      | spike first: install the pinned stack in a scratch container, lint one `.astro` fixture. If dead on 10, fall back to `astro-eslint-parser` + hand-picked rules, or defer with a note on #91 |
| `astro/valid-compile` needs `@astrojs/compiler` in-image | moot — rule deprecated, not baked; revisit if the plugin replaces it                                                                                                                        |
| floor rules misfire on astro AST                         | §3 scoping; test asserts `.ts` findings unchanged beside `.astro` findings                                                                                                                  |
| content caches (#68) serve stale `.astro` verdicts       | cache identity includes the tool pin (rebuild on pin bump) — confirm in `cache.mts`, no change expected                                                                                     |

## 6. Test plan

- step test: repo with `src/a.ts` (floor finding) + `src/B.astro` (astro
  finding) — both reported, config kind `house`.
- step test: repo with no `.astro` files — behaviour identical to today.
- config test: `.astro` file present, no repo eslint config — house config
  selected; sidecar story unchanged.
- proving ground: rdd-astro drops its `eslint.config.mjs`, runs the gate, keeps
  Astro linting + the floor. Close #91 on that evidence.

## 7. Order of work

1. Spike (§5 row 1) — decides viability before any pin lands.
2. Pin + Containerfile + rebuild (`comply.sh` rebuilds on pin change).
3. Config object + step extension + tests.
4. `standards/node-eslint.md` + README contract line if the README names the
   linted extensions.
5. rdd-astro proving-ground run; PR; close #91.
