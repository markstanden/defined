<!-- defined:start -->

This project is gated by Mark's portable defined gate. Run `defined comply` —
bootstrap, repair and verify in one pass. (`defined verify` is the
pipeline-only read-only check.) A missing ecosystem skips; a missing tool
fails loudly.

**When to run it.** After a coherent set of edits, before committing or
handing work back. One run after a batch beats one per file.

**Reading the result.** Both verbs print one compact JSON line: `status` and
actionable `errors` — read the errors instead of re-running tools by hand;
`--full` adds the per-check `results` map on a first, contextual run.

**After a run.** `git diff`: repairs are real edits to your tree. Fix
findings, then rerun — do not repeat an unchanged failing command. If a check
could not run at all, report the failing step and its error rather than
retrying it as-is. Do not weaken or disable a check just to get green — fix
the finding or raise it upstream.

**What the gate owns.** Bootstrap seeds house defaults (`.editorconfig`,
`.gitattributes`, `Directory.Build.props`) that this project then owns, and
manages plumbing (the CI workflow and this block), realigned on each run.
Edit the seeded defaults here as you wish; raise changes to managed files and
house standards upstream — never fork them locally.

**Public APIs are documented.** Doc comments carry purpose, parameters,
returns, constraints — never name-restating filler; small, well-named private
helpers need no block. The gate proves the sections exist; reviewers prove
the words match (`defined explain jsdoc/require-jsdoc`).

**Knowledge is documented.** Sectioned docs under `docs/`:
`Area`/`Keywords`/`Summary` front-matter, `Date` derived from git, claims
grouped Facts / Inferred / Tested / Open questions. Convention and scrub
checklist: `standards/documentation.md`.

**Looking things up.** `defined explain <step-or-rule>` serves house guidance
from the pinned image — offline, no repo writes, matched to the revision that
gates you; prefer it over reading the upstream repository. House standards:
`standards/` (tests, naming, API documentation, shell, YAML) and
`practices/architecture.md`. Tighten the floor; don't fork it.
<!-- defined:end -->
