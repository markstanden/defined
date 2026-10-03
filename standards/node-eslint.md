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
- the **public-API documentation floor** (2026-10-03): the `jsdoc/*` rules
  below. Per-repo tunable: `"eslint": { "requireJsdoc": false }` drops the
  floor (forwarded as `DEFINED_ESLINT_REQUIRE_JSDOC=off`); a repo-owned
  config governs itself and sees neither variable;
- `eslint-config-prettier` last, so ESLint never votes on formatting.

## The public-API documentation floor (2026-10-03)

Exported functions, arrow functions and function expressions, exported class
members (methods, accessors and fields), and interface members need a JSDoc
block carrying a real summary; where an author documents a parameter or a
returned value, the tag's description is mandatory and names must match the
signature. Rules:

- `jsdoc/require-jsdoc` — `publicOnly: { cjs: true, esm: true }` with contexts
  `FunctionDeclaration`, `ArrowFunctionExpression`, `FunctionExpression`,
  `MethodDefinition`, `PropertyDefinition`, `TSMethodSignature`,
  `TSPropertySignature`, and `enableFixer: false`.
  Oracle-verified on eslint-plugin-jsdoc 65.0.2 / ESLint 10.11.0 /
  typescript-eslint 8.70.1:
    - `publicOnly` covers `export`/`module.exports` functions but NOT exported
      class members — the explicit `MethodDefinition`/`PropertyDefinition`
      contexts make exported members reportable while private (`private`, `#`)
      members, non-exported classes and inline callbacks stay exempt;
    - `FunctionExpression` must be listed or a DOCUMENTED class method still
      reports as missing (the method's block only attaches through its
      function-expression node); listing it does not double-report methods;
    - interface members are reported regardless of the interface's own export
      marker (the plugin does not walk to the enclosing export); documented
      shapes stay clean, so the practical cost is documenting the shape once;
- `jsdoc/check-param-names` (fixer off) — a recorded `@param` name must match
  the signature, and a tag for a parameter that does not exist is a finding.
  `require-param-name` alone does NOT catch this (2026-10-03 review: a
  `@param typo` tag for `value` passed the floor). Destructured `root0`-style
  docs are accepted as written;
- `jsdoc/require-param-description`, `jsdoc/require-param-name` — a recorded
  parameter tag must carry a description;
- `jsdoc/require-returns-description` — a recorded `@returns` must carry a
  description;
- `jsdoc/require-description` — covers the declaration forms that require a
  block (`ExportNamedDeclaration:not(Program)`,
  `ExportDefaultDeclaration`, `MethodDefinition`, `PropertyDefinition`,
  `TSMethodSignature`, `TSPropertySignature`): an empty or whitespace-only
  block is a finding wherever a block is required. Ordinary summaries pass.

What the floor deliberately does NOT catch: a non-empty junk summary
(`/** silence */`) passes `require-description` everywhere — prose quality is
review work, and no shipped rule separates a junk word from a real one.
(`jsdoc/informative-docs` is the candidate if v2 wants this enforced; it
needs a false-positive audit across consumers first.)

Test files are exempt from the whole floor: a fixture firehose is not
machinery a future consumer calls into.

Deliberately outside the floor: `jsdoc/require-param` and
`jsdoc/require-returns` (tag-presence) are NOT enforced. In TypeScript, every
options-object parameter needs `@param root0` boilerplate for each destructured
member — hundreds of ceremonial tags across these modules and consumers (the
2026-10-03 adoption audit priced this repo alone at ~500 entries). Summary +
described-when-present tags is the v1 floor; the doctrine's "describe every
parameter" stays a documentation and review standard. Revisit in v2 once
repos converge.

## The floor never manufactures docs

Every rule that admits an auto-fixer runs with `enableFixer: false`
(2026-10-03: with fixers on, comply's repair pass filled this repo's own
tree with empty `@param root0` stubs that passed the check). A docblock must
be written by a human or agent who read the code; a stub that exists to
turn a check green is worse than no docblock, and the gate must not
produce that path. A failing finding is resolved by writing the prose.

## What the floor cannot do

A linter proves the sections exist and carry words. It cannot prove the words
describe the real behaviour — that is review work. Never add a comment to
satisfy the rule; document private helpers only when their behaviour needs
explanation, and write `@param`/`@returns` text that a caller cannot guess
from the signature (accepted ranges, null/empty behaviour, thrown failures).
House doctrine lives in [`documentation.md`](documentation.md).

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
