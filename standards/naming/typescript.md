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

TypeScript naming is not enforced by a built-in gate step. Projects declare
their own rules command under the `.defined.json` `naming` key (see
[`../naming.md`](../naming.md)); ESLint's
`@typescript-eslint/naming-convention` rule (camelCase functions, PascalCase
types, UPPER_CASE constants; looser properties for env-var and wire-format
names) is the reference implementation.
