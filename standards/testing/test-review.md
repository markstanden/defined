# Test review: hygiene rules and the ratchet

Test hygiene doctrine for the gate: which test defects are mechanical and
always-on, which are review leads that need the contract, and how a legitimate
exception is recorded. One rule engine, one rule id, one wording — the review
skills read this output instead of carrying their own copy of the rules.

## Where the rules run

The read-only `test-hygiene` step serves all three surfaces, and the caller
selects scope, never rules:

| surface                         | scope                   | rules                                 | purpose                             |
| ------------------------------- | ----------------------- | ------------------------------------- | ----------------------------------- |
| `defined verify` / `comply`     | whole git inventory     | always-on defects                     | merge gate, CI                      |
| `defined scan`                  | whole git inventory     | always-on defects                     | install-less try-out, ungated repos |
| `defined scan --files <paths…>` | exactly the named files | always-on defects **and** review tier | the review pass                     |

- The rule set is chosen by the step, not the caller. `--files` widens it to the
  review tier for exactly those files; no flag selects an individual rule or a
  tier on its own.
- Output is the same diagnostics shape as `verify`: rule id, file, line,
  message. The reviewer reads it; nothing parses prose.
- `--files` is a `scan` flag only. `verify` has no file list, so a reviewer
  cannot narrow the merge gate.
- A named file is authoritative: an untracked file is read from the working
  tree, a non-test file is checked (usually nothing applies), and a file outside
  `.defined.json` `scope.include` is scanned anyway. Two hard errors guard
  typos: `--files` with no values, and a path that does not exist on disk.
- There is no baseline, allowlist, history mode or "new findings only" filter.
  Scope is the only variable, and it is explicit.

## Defect and lead

- A **defect** is a test that silently does not run, does not assert, or cannot
  fail for any input. Its cause and its fix are mechanical. It fails every
  surface, and it cannot be suppressed.
- A **lead** is a measurement that may have a legitimate shape. It fails the
  `--files` pass until it is fixed or suppressed, and the reviewer promotes it
  into a finding only after reading the test and the contract, naming the
  evidence that promoted it. A quiet rule is not a verdict.

## Always-on defects

| rule id                     | defect                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focused-test`              | `.only` on a test: the rest of the suite silently does not run.                                                                                                                    |
| `focused-suite`             | `.only` on a suite: every other suite silently does not run.                                                                                                                       |
| `theory-without-data`       | a `[Theory]`/`[DataTestMethod]` with no `InlineData`/`MemberData`/`ClassData`/`DataRow`, or an `it.each([])` table: the runner executes zero cases and reports green.              |
| `unawaited-async-assertion` | an async assertion (`Assert.ThrowsAsync`, `ThrowAsync`, Jest `.rejects`) neither awaited nor returned: the assertion never executes. Expression-arrow bodies return it implicitly. |
| `no-assertions`             | no recognised assertion call in the delimited body. An assertion helper counts only when named with the verb (`assertX`, `expectY`, `shouldZ`).                                    |
| `literal-tautology`         | a comparison of a literal with itself, or an expression with itself: it cannot fail for any input.                                                                                 |
| `commented-out-assertion`   | an assertion commented out instead of deleted: the test asserts nothing at that point.                                                                                             |
| `swallowed-exception`       | a `catch` block that neither asserts nor rethrows: any exception passes, including the wrong one. Exempt: set a flag in the catch and assert it afterwards.                        |
| `skipped-test`              | a skip that cites no ticket reference (in its own line or the contiguous comment above) and carries no annotation reason where the framework records one (C# `Skip = "…"`, PHPUnit `markTestSkipped("…")`): the unskip work is untracked. A plain comment is not a reason.                    |
| `no-tests`                  | an OpenCollection request declaring neither runtime assertions nor a test script: nothing checks the response.                                                                     |
| `hardcoded-host`            | a literal scheme and host in a request URL instead of a variable.                                                                                                                  |
| `plaintext-credential`      | a literal credential in a request auth block.                                                                                                                                      |
| `unlabelled-secret-var`     | a credential-named environment variable holding a literal value and not marked secret.                                                                                             |

The three secrets rules are bounded to test-collection hygiene — test files and
OpenCollection requests/environments — and are never a repo-wide secrets sweep.

## Review tier

| rule id                 | lead to read                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing-structure`     | the phase labels do not cover the body's phases: `Act` and `Assert` labelled separately or as `// Act & Assert`; `Arrange` only when statements precede the first label. Confirm the labels are absent; a single-expression arrow body and a body with no setup are exempt. |
| `multi-statement-act`   | the act region, from its label to the next label or the body's end, holds more than one depth-0 statement: two outcomes pinned, or an act and an assert sharing a label.                                                                                                    |
| `compound-assertion`    | one assertion joins two conditions (`Assert.True(a && b)`): the failure message cannot say which broke. Usually two assertions.                                                                                                                                             |
| `conditional-assertion` | an assertion inside an `if`/`else` or a braceless guard: it may never run, let alone fail. A branch the test itself controls can be fine; a branch decided by the code under test is the lead.                                                                              |
| `assertion-in-loop`     | an assertion inside a `for`/`foreach`/`while` body or a `.forEach` callback: several cases reported as one test, with only the first failure visible. Looping one returned collection to assert each element is one behaviour.                                              |
| `else-branch-assertion` | an `else` branch that asserts: both branches asserting is two tests in one.                                                                                                                                                                                                 |
| `ambient-clock`         | a read of the wall clock: the result depends on when the test ran.                                                                                                                                                                                                          |
| `sleep`                 | a sleep or delay: the test races the clock instead of controlling it.                                                                                                                                                                                                       |
| `randomness`            | a random value or identifier: the input is not reproducible.                                                                                                                                                                                                                |
| `ambient-environment`   | an environment variable, working directory or machine name read.                                                                                                                                                                                                            |
| `ambient-locale`        | the current culture or locale read.                                                                                                                                                                                                                                         |
| `real-network`          | a real network client: the test needs a reachable peer.                                                                                                                                                                                                                     |
| `real-filesystem`       | real file, directory or temp-path access: the test needs a writable host.                                                                                                                                                                                                   |
| `process-spawn`         | a child process started: the test needs the host's binaries.                                                                                                                                                                                                                |
| `debug-output`          | console or debug output left in a test.                                                                                                                                                                                                                                     |

A determinism lead is legitimate when the effect is the subject: a clock
boundary, a serialisation test over a real temporary file. Control it and say so
with a why-note, or inject the effect.

## Leads the gate does not own

These stay with the review pass; they need the contract, the intent or the
reader, so they are reported and never fail a gate surface.

| rule id                    | why it is a measurement, not a defect                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `identical-body-shape`     | normalised bodies collide, and two contracts can share a shape. Similarity is never a deletion finding.                                      |
| `single-row-parameterised` | a one-row table can be ceremony, or the one boundary case that matters.                                                                      |
| `literal-expectation`      | a bare literal can be idiomatic arithmetic or a business value that lost its name.                                                           |
| `computed-expectation`     | the expectation can derive from the contract or copy the implementation's own formula; ask where it came from.                               |
| `computed-title`           | a call or template title can resolve to one stable, descriptive name; a title built at run time is invisible to name search. No suppression. |
| `property-trigger-unmet`   | a dual pair or a table of four or more rows with neither a property nor a why-not note; converting is a judgement.                           |
| `single-line-summary`      | a one-line C# `<summary>` can restate the member or say something useful; judge the text, not the length.                                    |
| `status-only-tests`        | an endpoint whose whole contract is the status code is legitimately status-only.                                                             |
| `legacy-bru-present`       | a legacy `.bru` file beside an OpenCollection collection is a migration fact, not a broken test.                                             |

Judgement the gate never owns: the behaviour inventory, contract authority,
oracle independence, boundary and null/whitespace coverage, parameterisation and
shared-setup decisions, test naming, AND/WITH reading, property-test
judgement, coverage interpretation and the report shape. Those belong to the
review skills and `UNIT_TESTS.md`.

Owned elsewhere, pointed at rather than restated: coverage minimums and
evidence (`node-coverage`, `dotnet-coverage`), formatting (prettier), lint and
complexity (`eslint`), module purity and CQS (`purity`), identifier naming
(`naming`), shell and YAML. `defined explain <topic>` serves each offline.

## Suppression

A review-tier lead is suppressed by a note beside the test, in one grammar:

```text
// Why use <rule-id> here: <reason>
// Why not use <rule-id> here: <reason>
```

```ts
// Why use ambient-clock here: the test pins the formatter's clock boundary
// Why not use property here: rows are fixed boundary cases, not a law
```

- **Review tier only.** An always-on defect cannot be suppressed; the attempt is
  itself a finding. `computed-title` has no escape at all.
- **Placement.** The note sits in the contiguous comment block immediately above
  the test declaration, with no blank line between. A note further up the file,
  or above an unrelated declaration, does not apply.
- **Exact id.** The token is the rule id, case-sensitive. A misspelt id
  suppresses nothing and is reported as an unknown suppression. `property` is the
  one accepted alias for `property-trigger-unmet`; there are no other aliases.
- **Reason mandatory.** The reason must say how the construct is controlled, or
  why the rule does not apply. Empty, `legitimate`, `intentional`, `required`
  and similar restatements are vacuous, and a vacuous note is a finding.
- `here` is accepted and ignored.
- One note suppresses one rule for one declaration. No wildcards, no
  file-wide or repo-wide notes.

## The ratchet

- Review-tier rules apply to the files the pass names. Every finding in a named
  file is fixed, including pre-existing debt: a file is clean once it is
  touched. Untouched files are not retrofitted in bulk.
- A large legacy file can be expensive to touch; say so in the verdict and let
  its owner split the change rather than doing the retrofit here.
- Historical structure debt does not block CI. That is the accepted trade for
  having no baseline and no history mode: always-on defects still gate every
  surface.

## Limits

- Rules read source after strings and comments are masked, so a code fragment
  quoted in a string never fires, and a tautology on two identical string
  literals is not detected.
- Semicolonless stacks (Python, Go) count zero statements in the act region.
- A single-expression arrow body is never reported for structure, and a computed
  title is not inventoried.
- An alias or an indirect call can hide an effect from a pattern rule. The gate
  proves the shapes it names, not the absence of everything else.
- The engine never measures coverage and never estimates it.
