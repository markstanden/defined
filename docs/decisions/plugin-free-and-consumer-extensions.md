---
Area: decisions
Keywords: astro lint, tailwind, plugin-free, extension seam, consumer tasks, issue 91, issue 92, eslint fixers
Summary: Review of backlog #91/#92 that rejected baking Astro/Tailwind support into the gate and named consumer tasks as the extension seam instead.
---

# Plugin-free for now, and consumer tasks as the extension seam

Review of the two open backlog issues — #91 (Astro linting in the ESLint step)
and #92 (Tailwind position) — across a discussion of what the gate's fixers
actually buy. The Astro bake we were about to plan turned out to be the wrong
lever; the right one is an extension seam for consumers.

## Evidence

**The Astro fixer inventory, priced per rule** (eslint-plugin-astro rule table,
checked 2026-10-04):

| fixer                                                                                | what it does                            | turns deleted                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `astro/semi`                                                                         | frontmatter semicolons                  | none — prettier-plugin-astro already formats frontmatter                                                                                                                          |
| `sort-attributes`                                                                    | reorders attributes                     | none — un-adopted preference; core prettier preserves attribute order by design, so nothing duplicates it, but non-redundant ≠ valuable: the rule manufactures the churn it fixes |
| `prefer-class-list-directive`, `prefer-object-class-list`, `prefer-split-class-list` | rewrites class expressions              | none — un-adopted taste; also reshapes what prettier-plugin-tailwindcss sees                                                                                                      |
| `no-set-text-directive`                                                              | `set:text={x}` → `{x}`                  | ~none — Astro's docs call the directive uncommon                                                                                                                                  |
| `no-deprecated-astro-fetchcontent`                                                   | `Astro.fetchContent()` → `Astro.glob()` | none — fires only on Astro ≤2 (API removed in v3, 2023); its fix target is itself deprecated                                                                                      |

The rules worth detecting (`set:` conflicts, `client:only` value, `set:html`,
component exports) are unfixable by design — the fix is a decision.

**Prettier cannot sort attributes natively.** Props/attribute sorting is
prettier issue #323, open for roughly a decade; the option philosophy rejects
it. `prettier-plugin-astro` formats but preserves order. Sorting would need a
third-party plugin with printer-integration risk.

**The gate formats no `.astro` today.** `PRETTIER_EXTENSIONS` in
`runtime/steps/node.mts` has no `astro`; the baked prettier config declares
itself pure defaults with zero plugins. Repos with their own prettier config
(rdd-astro) get astro formatting via the #40 dependency restore; config-less
repos get nothing.

## Decisions

1. **Plugin-free for now.** No new baked ecosystem plugins — no
   `eslint-plugin-astro`, no `prettier-plugin-astro`, no Tailwind plugin. The
   baked prettier config keeps its zero-plugin purity; the house ESLint floor is
   unchanged. A real consumer need reopens a bake deliberately.
2. **Remediation taxonomy for rule selection.** Information-free transformation
   (formatting, sorting, mechanical renames) → autofix on CPU, the turn
   disappears; durable-information creation (docs) → detect on CPU, the agent
   reasons once and the artefact endures; semantic judgement (a11y, conflicts,
   template rewrites) → detect only. The unit of economy is the **turn**:
   `comply` collapses run-read-fix-rerun into one CPU pass, and a reliable fixer
   deletes a turn outright.
3. **Consumer tasks are the extension seam.** Capability arrives as
   `.defined.json`-declared tasks that `comply` runs _alongside_ the house steps,
   so a consumer's Astro lint or Tailwind check coexists with the floor instead
   of replacing it. Design: `docs/plans/PLAN_consumer-extensions.md`.

## Consequences

- **#91** resolves as: the floor stays; Astro linting is a consumer task (or a
  repo-owned config today) — not a bake.
- **#92** resolves as: no Tailwind capability in the gate; class sorting stays
  consumer prettier's job; a conflict check is a consumer task if ever wanted.
- README and `standards/` describe the `tasks` key **when the mechanism lands**
  (docs match behaviour); until then the decision lives here, in
  `practices/architecture.md`, and in the plan.
- **History (kept, resolved):** the two superseded design drafts —
  [`91-astro-lint.md`](../issues/91-astro-lint.md) (#91) and
  [`92-tailwind-position.md`](../issues/92-tailwind-position.md)
  (#92) — retain the per-rule fixer pricing and the attribute-sorting analysis
  behind the decisions.
