# Node testing and quality standards

House conventions for Node/TypeScript projects, mirroring
[`unit-testing.md`](unit-testing.md) for .NET.

## What the gate enforces

The `node` step activates on a tracked `package.json` or `*.md` file and formats
the repo with prettier (house config + `.editorconfig` for indentation).
`node-deps` restores the consumer's dependencies first, and `node-checks` then
runs the consumer's declared ESLint/`tsc`/tests from the package's own
`node_modules/.bin` — never the gate's global tools. Nested and monorepo
packages are supported; an absent declaration skips cleanly. The `.defined.json`
`node` key and its examples are documented in the [README](../../README.md).

## Testing stack (gate-internal, guidance)

These conventions apply to the `defined` runtime's own `*.test.mts` suite and
are a recommendation for consumer Node projects, not a mechanically enforced
rule:

- **Runner**: `node --test` (Node ≥ 26 strip-types) — zero dependencies keeps
  "drop in anywhere" honest; no vitest/jest required.
- **Assertions**: `node:assert/strict`.
- **Structure**: label the phases `// Arrange`, `// Act`, `// Assert` inside the
  test body, one behaviour per test — a failing test name should say what broke.
  This is a ratchet: required for new and changed tests, and for historical
  tests as each area is retrofit. Where one statement both exercises the unit
  and asserts on it, use the single label `// Act & Assert` rather than
  pretending the phases split. A body with no setup has no Arrange phase: omit
  the label rather than inventing one, and do not add ceremony to satisfy a
  scanner count.
- **`and` in a name is a flag, not a defect.** Read the test: split it when the
  halves sit on different code paths or different moments, so a red test would
  blame the wrong half (status plumbing versus cleanup; an arrange-time
  invariant versus an after-the-fact side effect; any two `Act` steps). Leave
  the commonplace pairing alone — one act that produces one outcome plus its
  echo (`reportsFindingAndExits`, `fails and logs`, `lists tracked and
  untracked`) is a single behaviour.
- **Assertion helpers carry the verb**: name a helper `assertX(...)` (e.g.
  `assertLoadRejects`), never `rejectsLoad(...)`. The reader and the review
  scanner both look for the verb; without it a helper reads as "no assertions".
- **Colocation**: tests live next to the module as `<module>.test.mts`.
- **No test grab-bags**: one test file per module.

## Module conventions (gate-internal, law)

These are conventions for the gate's own `runtime/` and `lib/` TypeScript
modules, not enforced against consumer code:

- **No enums/namespaces**: bare string-literal unions (e.g. `"fix" | "no-fix"`).
- **Extensioned imports**: `./foo.mts`, never extensionless.
- **Zero dependencies** in modules: Node built-ins + `lib/` shared blocks only.
- **Object params**: public functions take one destructured object; positional
  params only for genuinely unary operations.
- **Runnable modules never end in `-test`**: Node's `*-test.*` discovery glob
  would execute them.
- **Injected runner**: modules that invoke binaries accept an optional
  `runner` param so tests need no host binaries.

## Test naming

`[methodName]_[condition]_[expectedBehaviour]` — same shape as the C#
convention in `unit-testing.md`.

## TDD

Write the failing test first, then the module. Keep changes small, testable,
one concept at a time.
