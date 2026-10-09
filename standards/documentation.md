# Documentation

House doctrine for API documentation — the "why" behind the gate's
documentation checks. One question, one answer:

> **Public APIs describe their contract; everything else documents itself or
> stays quiet. Never write a comment to satisfy a linter.**

The other half is durable knowledge: how to write the docs under `docs/` — see
[Knowledge docs](#knowledge-docs).

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

## Knowledge docs

Durable knowledge lives under `docs/<area>/<title>.md`. A doc serves two
readers at once — the human skimming subtitles and the model that pays for the
`Summary` line instead of a full read — so write short, sectioned,
self-describing docs and both are served by the same artefact.

- **Front-matter.** `Area` (from the path), `Keywords` (search terms) and
  `Summary` (a self-contained one-line TL;DR). `Date` is **not** front-matter:
  it is derived from the doc's last git commit, else its mtime. Never
  hand-maintain a date, in front-matter or in a heading.
- **Sectioned with subtitles.** An H1, then H2 sections a reader can navigate
  from the catalogue line alone. Tables, bullets and code blocks over prose.
- **Grade claims by section.** Group a problem domain's claims (an H2) by how
  much a reader may rely on them: **Facts** (directly observed; each bullet
  cited with a `file:line`, command + output, hash or quoted log), **Inferred**
  (reasoned from the facts, naming the evidence and the gap), **Tested** (proven
  by a reproduction, steps shown) and **Open questions** (answerable, naming
  what is blocked). A claim with no citation is not a Fact.
- **Link, don't restate.** Link a definition (this file, a source file); never
  copy a table or this grading legend into a new doc.
- **Short.** ~400 words a doc; past ~1,200 words add a `> Split plan:` line
  under the H1 and split it at the next close-out, repointing inbound links.
- **Scrub before committing.** No personal data, org or tenant identifiers,
  secret values or paths, or machine-specific absolute home paths. Keep version
  numbers, commit SHAs and scratch paths — they make a doc reproducible.
