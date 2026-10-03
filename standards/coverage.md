# Coverage standards

The gate enforces coverage through two steps: `node-coverage` (lcov) and
`dotnet-coverage` (Cobertura). Each runs the consumer's command, then parses
the report at a **fixed path** and checks it against configured minimums.

## Fixed report paths

The gate reads only these locations, so the command must land its report there:

| Step              | Report                                                              |
| ----------------- | ------------------------------------------------------------------- |
| `node-coverage`   | `coverage/lcov.info`                                                |
| `dotnet-coverage` | `coverage.cobertura.xml`, else `TestResults/coverage.cobertura.xml` |

The paths travel with the image (`runtime/steps/`), so they are not
configurable; a report written anywhere else is treated as missing.

## Configuration

Everything else is consumer-owned in `.defined.json` under
`coverage.<ecosystem>`:

- `command` — the shell command that generates the report.
- `minimums` — `line`, `branch` and `function` percentages. Omitting the key
  entirely defaults to **80% line**; an absent metric is not checked.
- `satisfies` (node only) — names a `node.checks` entry the coverage command
  also runs, so `node-checks` skips it instead of running the suite twice.

The gate is the single threshold authority: declare minimums here only, never
duplicate them in XML (for example a coverlet `Threshold`).

Runnable examples live in the [README coverage section](../README.md).

## Verify vs comply

- A read-only `verify` runs the command against a scratch copy of the git scope
  under `/tmp`, so it never writes into the repo.
- A write-capable `comply` runs it in the repo so the report survives at the
  fixed path, where a scanner such as SonarQube reads it.

Generation is verification, so both steps run once in the no-fix pass; repair
never regenerates coverage.
