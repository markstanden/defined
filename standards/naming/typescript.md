# TypeScript naming conventions

Part of the house naming doctrine (see [`../naming.md`](../naming.md)). This
file is the authority for TypeScript identifiers and module file names.

> **What you export is camel (nothing).**

## Identifiers

| Identifier              | Style            | Example                         |
| ----------------------- | ---------------- | ------------------------------- |
| Functions               | camelCase        | `parseObserveArgs`              |
| Types / interfaces      | PascalCase       | `ReviewOptions`                 |
| Classes                 | PascalCase       | `GitError`, `TestGitRepository` |
| Module constants        | SCREAMING_SNAKE  | `GROUP_ORDER`, `MENU_ITEMS`     |
| CLI entry               | `run<Domain>Cli` | `runObserveCli`                 |
| CLI flags / subcommands | kebab-case       | `--idle`, `--manual`, `plan`    |

Anything user-facing lives in `bin/` as a `#!node` shebang script that imports
from `lib/`; `lib/` modules are libraries and are never invoked directly by a
user. Test files are colocated `*.test.mts`.

## Files

- **All file names are kebab-case, lowercase.**
- `lib/`: `<domain>.mts` (libraries) and `<domain>-cli.mts` (CLI facades,
  tested).
- `bin/`: `<command>` — thin executable scripts.

## Enforcement

TypeScript naming is enforced by the gate's ESLint step: the baked house config
runs `@typescript-eslint/naming-convention` as `error` (selectors and oracle
notes in [`../node-eslint.md`](../node-eslint.md)), so a repo with no
`eslint.config.*` of its own inherits the table above as a gate check. A
repo-owned config governs itself.

Projects may still declare their own rules command under the `.defined.json`
`naming` key (see [`../naming.md`](../naming.md)) for names the
naming-convention rule cannot see — shell functions, workflow filenames and
other non-TypeScript identifiers; the gate's `naming` step provides that
framework and the workflow-filename grammar.
