# Documentation

House doctrine for API documentation — the "why" behind the gate's
documentation checks. One question, one answer:

> **Public APIs describe their contract; everything else documents itself or
> stays quiet. Never write a comment to satisfy a linter.**

## The contract

- **Public surface (exported JS/TS, publicly visible C#):** every type,
  function/method and property carries a doc comment that explains purpose and
  observable behaviour — not the name restated. Describe:
    - parameters: meaning, accepted ranges, defaults, and null/empty behaviour
      when it differs from "invalid";
    - return values: meaning, and what null/empty/false means when it can
      happen;
    - thrown failures and important side effects where they exist;
    - C# properties: `<summary>` (and `<value>` where the distinction helps).
- **Non-public code:** document behaviour that needs explanation — an
  invariant, a non-obvious decision, a subtle algorithm. Small, well-named
  private helpers extracted to reduce complexity need no ceremonial block.
- **Never filler:** no name-restating prose, no empty scaffolds, no type
  repetition the signature already carries. A docblock that exists only to
  pass a lint rule is debt, not documentation.
- **Meaningfulness is review work.** The gate proves sections exist and carry
  text (TS: `jsdoc/*` rules, `standards/node-eslint.md`; C#: `CS1591` under
  the build's warnings-as-errors). Only a reviewer can prove the text matches
  the behaviour — review docblocks against the implementation and tests.

## How the gate enforces it

- **TypeScript:** the ESLint step's `jsdoc/*` rules (house config; see
  [`node-eslint.md`](node-eslint.md) for the rule list, its deliberate
  strength, oracle notes, the no-auto-fill guarantee and the `requireJsdoc`
  override).
- **C#:** `standards/Directory.Build.props` enables
  `GenerateDocumentationFile` without the `CS1591` suppression, so the
  compiler warns for every publicly visible member without a doc comment, and
  `TreatWarningsAsErrors` makes the warning fatal. A repo that owns its copy
  of the props file opts in by removing the suppression (or opts out with
  `"dotnet": { "disable": true }` — deliberately, never silently).
- **StyleCop.Analyzers** may follow for C# structural completeness
  (empty/placeholder sections); it is not installed — the compiler floor and
  this doctrine are the contract for now.

## Adoption notes

- Existing consumers with their own `Directory.Build.props` keep their copy
  (seeded defaults install only when absent); add the same change to opt in.
- Consumers with their own `eslint.config.*` govern themselves; the floor
  applies to house-config consumers, and the sidecar
  (`eslint.config.defined.mjs`) shows the current default.
- Pinned consumers see the new floor only after `defined update` — read the
  release notes before bumping the pin.
