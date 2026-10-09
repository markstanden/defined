---
Area: issues
Keywords: tailwind, css, issue 92, non-goal, class sorting, superseded, consumer prettier
Summary: Superseded plan recording Tailwind as a documented non-goal for the gate — class sorting stays the consumer's prettier plugin.
---

# PLAN: Tailwind CSS — position, not a step (#92)

**Status:** superseded — kept as history; the GitHub issue remains open. The
position it argued (documented non-goal) is the decision; the _mechanism_ here
(an `explain` notice) is superseded by
[`plugin-free-and-consumer-extensions.md`](../decisions/plugin-free-and-consumer-extensions.md):
no Tailwind capability in the gate, class sorting stays consumer prettier's job,
a conflict check is a consumer task if ever wanted.
**Issue:** #92 — open; the design resolves as "non-goal".

## 1. The decision

Recommend **documented non-goal** for Tailwind as a gate concern today, with a
recorded reopen trigger. No new image deps, no new step, no ruleset.

Reasoning against the issue's three asks:

- **Class order house-wide via baked prettier plugin?** No. The node step
  prefers a consumer prettier config (`runtime/lib/prettier-config.mts`), and
  sorting accuracy needs the repo's own Tailwind context (config, version,
  tokens) — a baked default sorts worse than the consumer plugin it would
  displace. Sorting is already served: rdd-astro's `prettier.config.mjs` +
  `prettier-plugin-tailwindcss` run under the gate with deps restored (#40).
- **`tailwind` ESLint entry?** Not yet. `eslint-plugin-tailwindcss` is dormant;
  the maintained line is `better-tailwindcss`. Its real value is conflict
  detection (`p-2` + `p-4`, hidden display combos) — genuine, but no consumer
  has shown that pain. Config doctrine: "add rules as they earn their place,
  and date each addition". No evidence, no rule.
- **Documented position?** Yes — the gap is that the position is implicit.
  Make it queryable.

## 2. Scope of the non-goal

- Class sorting: prettier's job, consumer plugin, consumer config. The gate
  restores its deps and stays out of the ordering.
- Conflict/consistency linting (`better-tailwindcss` class): out of scope until
  a consumer hits it.
- Tailwind config validation: out of scope (the Tailwind CLI/compiler owns it).

**Reopen trigger:** a gated repo reports class-conflict or Tailwind-consistency
findings that review actually caught and tooling missed — then bake
`better-tailwindcss` (or its successor) under the house config, same pattern as
#91's plugin, and date the addition.

## 3. Where the position lives

`defined explain tailwind` — a notice-only topic, no standards doc, no step:

- `runtime/lib/explain.mts`: `STEP_IDS`/`STEP_ENTRIES` gain a `tailwind` entry
  (kind `step`, `docRel: null`, `notice:` carrying the §2 position in one
  line, owner `n/a` — the gate runs nothing Tailwind-shaped).
- `runtime/lib/explain.test.mts`: case asserting topic resolves, notice served,
  exit path stays 0.
- `README.md`: one line under the step list naming Tailwind a non-goal with the
  reopen trigger, so adopters see it without asking explain.

Why notice-only, not a `standards/tailwind.md`: the `notice` field exists for
exactly this — sole guidance for a topic with no house doc. A one-paragraph
standards file would imply a governed practice; a non-goal is a position.
(Alternative if the Guv prefers docs verbatim-served: the same paragraph as
`standards/tailwind.md` + `docRel` — equal cost, more weight.)

Not adding `tailwind` to the run plan: explain topics may be synthetic
(`bootstrap` is), but a step id that never runs invites "why is it skipped?"
questions. The explain entry maps a word to a position, nothing more.

## 4. Tests

- explain test: `tailwind` resolves; notice text mentions prettier ownership;
  owner side `n/a`.
- README link/no other drift — the gate self-hosts, `comply` is the check.

## 5. Order of work

1. Guv confirms non-goal vs bake-a-plugin (this plan assumes non-goal).
2. explain entry + test; README line.
3. `node --test` + `./runtime/comply.sh --check-only`; PR; close #92 with the
   position quoted in the close comment.

## 6. Risks

| risk                                        | mitigation                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| position reads as "the gate hates Tailwind" | wording names what _is_ served: sorting via consumer prettier under the gate               |
| reopen trigger too vague to act on          | trigger names the actor (a gated repo) and the evidence (review-caught conflicts)          |
| a future plugin bake contradicts this doc   | the entry is one notice line + README line; both deleted in the same PR that adds the step |
