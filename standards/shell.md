# Shell standards

Hard rules for tracked shell scripts. Naming is separate — see
[`naming/shell.md`](naming/shell.md). The gate's `shell` step runs **shfmt**
(format) and **shellcheck** (analysis, floor `style`) over the repo's git scope,
so these are enforced, not advisory.

## Rules

- **Bash, explicitly.** Shebang `#!/usr/bin/env bash` — never `#!/bin/sh`.
  The scripts rely on bash; a POSIX shebang invites silent breakage.
- **`[[ ]]`, not `[ ]`.** Use `[[ ]]` for conditionals. It needs no quoting
  against word-splitting, supports `&&`/`||`, and avoids the classic
  `[ $x = y ]` failure on empty or spaced values.
- **Explicit `return`.** End every function with `return` — `return 0` on
  success — so the exit status is deliberate rather than whatever ran last.

## Enforcement

shellcheck gates at floor `style` (every finding fails) using the image's own
config; shfmt owns formatting, and `comply` rewrites in fix mode before
re-checking. File and function names follow the naming doctrine
([`naming/shell.md`](naming/shell.md)), enforced by the project's `.defined.json`
`naming` command.
