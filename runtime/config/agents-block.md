<!-- defined:start -->

This project is gated by Mark's portable defined gate. Run `defined comply` —
bootstrap, repair and verify in one pass; use it every time. (`defined verify`
is the pipeline-only read-only check.) A missing ecosystem skips, a missing
tool fails loudly.

**When to run it.** After a coherent set of edits, and before committing or
handing work back. `comply` repairs what it can and re-verifies, so one run
after a batch of changes beats a run per file.

**Reading the result.** Both verbs print one compact JSON line: `status` and
actionable `errors` (file/line/rule where the tool gives them). Read the errors
instead of re-running tools by hand. Add `--full` on a first, contextual run for
the per-check `results` map; it is noise once you know the plan.

**After a run.** Inspect what the gate changed (`git diff`) — repairs are real
edits to your tree. Fix remaining findings, then rerun; the rerun is worth it
only once you have addressed their cause, so do not repeat an unchanged
failing command. If a check could not run at all, report the failing step and
its error rather than retrying it as-is. Do not weaken or disable a check just
to get green — fix the finding, or raise it upstream.

**What the gate owns.** Bootstrap seeds house defaults (`.editorconfig`,
`.gitattributes`, `Directory.Build.props`) that this project then owns, and
manages plumbing (the CI workflow and this block), which is brought back in
line on each run. Edit the seeded defaults here as you wish; raise changes to
the managed files and the house standards upstream — never fork them locally.

**Public APIs are documented.** Exported functions, properties and public
.NET members carry doc comments describing purpose, parameters, returns and
relevant constraints — never name-restating filler written to pass a lint
rule; small, well-named private helpers need no block. Meaningfulness is
review work: the gate proves the sections exist, reviewers prove the words
match the behaviour (`defined explain jsdoc/require-jsdoc`,
`standards/documentation.md`).

**Looking things up.** For what a step or rule means, run `defined explain
<step-or-rule>`. It serves the house guidance straight from the pinned image —
offline, no repo writes — and names whether the configuration is house-owned or
overridden by this repo. Prefer it over reading the upstream repository, which
may be newer than the revision actually gating you.

House standards live in the defined repo
(<https://github.com/markstanden/defined>): `standards/` covers tests, naming,
API documentation, shell and YAML; `practices/architecture.md` covers delivery,
structure and working style. Read the relevant file when a task touches that
area. Tighten the floor; don't fork it — raise improvements upstream.
<!-- defined:end -->
