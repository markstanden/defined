---
Area: conventions
Summary: Docs are sectioned, tabular, and self-describing — one style card serves the human and the model.
Keywords: documentation, style, summary, front-matter, sections, tables, tldr
Status: active
---

# Documentation style

A doc serves two readers at once: the human who skims subtitles and tables, and
the model that pays for the `Summary:` line instead of a full read. Write short,
sectioned, self-describing docs and both are served by the same artefact.

## The rules

1. **Sectioned with subtitles.** Every doc opens with an H1, then H2 sections
   named so the reader can navigate from the catalogue line alone.
2. **Tables, bullets, code blocks over prose.** Facts tabulate, steps bullet,
   commands fence, prose connects — no `<br>` hacks.
3. **`Summary:` is the TL;DR.** One front-matter line, self-contained sentence.
   If it can't be written, the doc needs a section, not a sentence.
4. **Short.** ~400 words to a doc. An oversized doc carries a `> Split plan:`
   line under its H1 naming the pieces, and is split during the next session's
   close-out, repointing inbound links. The `Summary:` stays a TL;DR.
5. **Link, don't restate.** Link a definition (`EVIDENCE-TAGS.md`, this card);
   never copy a table into a new doc.
6. **Front-matter.** `Area` (from the path), `Keywords`, `Summary`. `Date` is
   derived from git — never hand-maintained.

## Sniff test

Suggested sizes: a note ≤ 300 words, a reference ≤ 500. If a doc grows past
~1,200 words it smells — add a `Split plan:` line under the H1 and defer the
split to the next close-out.
