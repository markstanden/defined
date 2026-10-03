---
Area: plans
Date: 2026-10-03
Keywords: jsdoc, CS1591, Directory.Build.props, eslint-plugin-jsdoc, enableFixer, check-param-names, require-jsdoc, publicOnly, CA1822, CA1052, e2e fixture, requireJsdoc
---

# Public-API docblock floor

How the gate came to require documentation on public APIs (branch
`tights-api-docblocks`, commits `d612ead`…`4ab330f`), the eslint-plugin-jsdoc
behaviours the rule set is built around, and the fixture proofs. Tag policy:
`~/.config/opencode/EVIDENCE-TAGS.md` — not restated here.

## What enforces what

- **TypeScript** — the house ESLint config
  (`runtime/config/eslint.config.mjs`): `jsdoc/require-jsdoc` (exported
  functions/arrow functions/function expressions, exported class members,
  interface members — block with a real summary), `check-param-names` +
  `require-param-description` + `require-param-name`
  (described-when-present), `require-returns-description`,
  `require-description` (empty/whitespace blocks are findings). Test files
  (`*.test.*`, `*.spec.*`) exempt. Override: `.defined.json`
  `"eslint": { "requireJsdoc": false }`, forwarded to the baked config as
  `DEFINED_ESLINT_REQUIRE_JSDOC`.
- **C#** — the seeded `standards/Directory.Build.props` no longer suppresses
  `CS1591`; with `GenerateDocumentationFile` + `TreatWarningsAsErrors` an
  undocumented publicly visible member fails the build.
- **Meaningfulness** is doctrine and review work
  (`standards/documentation.md`, the managed AGENTS block), never a lint
  claim.

## eslint-plugin-jsdoc oracle facts

All verified in-memory with `Linter.verify` against the exact pins
(eslint 10.11.0, eslint-plugin-jsdoc 65.0.2, typescript-eslint 8.70.1,
typescript 6.0.3), 2026-10-03. Fixtures live in `/tmp/opencode/jsdoc-spike`
(scratch, reproducible via `npm i` of those four packages).

- `[FACT]` `publicOnly` covers exported functions/arrows but NOT exported
  class members; explicit `MethodDefinition`/`PropertyDefinition` contexts
  make them reportable while `private`, `#`-private and non-exported classes
  stay exempt (case table: `method-missing-doc` 1 finding,
  `private-method`/`hash-private-method`/`nonexported-class` 0).
- `[FACT]` `MethodDefinition` without `FunctionExpression` also in contexts
  false-positives a DOCUMENTED class method ("Missing JSDoc comment" at the
  method node); with both listed the docblock attaches and there is no
  duplicate finding. Verified by toggling the context list over
  `/** Reads. */ export class Api { read(): number { … } }`.
- `[FACT]` bare `FunctionExpression` + `publicOnly` exempts inline callbacks
  (`[1].map(function (n) {…})` inside a documented exported function: 0
  findings) while `export const read = function () {…}` is flagged.
- `[FACT]` `require-param-name` checks tag PRESENCE only: `@param typo` for
  parameter `value` produced 0 findings; `jsdoc/check-param-names` flags both
  the mismatch ("Expected @param names to be \"value\". Got \"typo\".") and
  stale extras ("@param \"ghost\" does not match an existing function
  parameter"). Destructured `root0`-style docs pass as written, including
  defaulted members.
- `[FACT]` with the jsdoc fixers ENABLED, comply's repair pass manufactured
  empty `@param root0` stubs across this repo (38 files, +1119/−91 per
  `git diff --stat`) and the check then passed — the exact failure mode the
  floor forbids. Every fixable rule in the floor now runs
  `enableFixer: false`; the repair pass writes nothing (verified: eslint
  `--fix` over an undocumented export produced a byte-identical file).
- `[FACT]` `require-description` catches empty and whitespace-only blocks
  (`/** */`, `/**   */`) but a non-empty junk summary (`/** silence */`)
  passes everywhere, including interface methods. `jsdoc/informative-docs`
  is the candidate rule if v2 wants junk summaries enforced.
- `[FACT]` `require-returns` / `require-param` (tag-presence) were measured
  at ~500 boilerplate entries for this repo alone (destructured `root0`
  params) and are deliberately outside the v1 floor.

## ESLint mechanics traps

- `[FACT]` ESLint flat config ignores files outside the process CWD's base
  path silently: the same config+file run from a foreign cwd returned `[]`
  with rc 0, and from the repo root returned findings. Compliance sweeps
  must set `cwd` to the repo root.
- `[FACT]` in-memory `Linter.verify` needs a `files` match in the config
  object; without one every case reports "No matching configuration found
  for file.ts".

## C# floor and the e2e fixture

- `[FACT]` with the seeded props, `dotnet format --verify-no-changes` on the
  undocumented fixture class reported `error CS1591: Missing XML comment for
publicly visible type or member 'Probe'` and `…'Probe.Measure(int)'`
  (host SDK 10.0.112 and in-image SDK 10.0.401), and the comply result went
  `not_compliant` with the dotnet step red.
- `[FACT]` the dotnet step notice says "format found diffs (run with --fix)"
  even when the real cause is a build failure — format verify runs first and
  surfaces build errors. Pre-existing behaviour; attribute via a manual
  format run before debugging formatting.
- `[FACT]` a trivial public class under `AnalysisMode=All` +
  `TreatWarningsAsErrors` trips `CA1822` (member can be static) and, once
  static, `CA1052` (static holder not static). The fixture's documented
  `public static class` shape satisfies both with zero suppressions.
- `[FACT]` `dotnet test` on a packageless classlib exits 0 ("no tests"),
  SDK 10.0.112 host and 10.0.401 in-image.
- `[FACT]` the broken fixture reads dotnet-compliant on a fresh clone's
  check-only pass (no seeded props yet) and red after comply bootstraps them
  — the seeded-defaults adoption path is itself covered by the e2e.

## Corrections

- `standards/node-eslint.md` originally claimed a bare `/** silence */`
  block on an export is a finding. The oracle showed only empty/whitespace
  blocks are; the doc now says so and names `informative-docs` as the v2
  candidate.
- The first compliance sweep reported 0 findings for the whole repo — false
  zero caused by the eslint CWD/base-path trap above; the tree actually had
  120 undocumented interface members. The sweep tool now pins `cwd` and
  surfaces non-zero exits.
- An early draft asserted `MethodDefinition` alone was sufficient for class
  methods; the documented-method false positive above disproved it.

## Open work

- `[NEEDS INVESTIGATION]` StyleCop.Analyzers distribution for structured C#
  doc checks: baked NuGet cache vs consumer package reference, against a CPM
  consumer and offline mode. Blocks any "stronger than presence" C# floor.
- `[NEEDS INVESTIGATION]` `jsdoc/informative-docs` false-positive audit
  across consumer repos before enforcing junk-summary detection.
- `[NOT TESTED]` `jsdoc/require-param`/`require-returns` as a v2 floor —
  priced but never enabled; re-measure after consumer repos converge.
- `[RISK]` a future .NET SDK feature band that adds default CA rules will
  turn the e2e C# fixture red for non-doc reasons; scope such rules in the
  fixture when they are unrelated to documentation.
