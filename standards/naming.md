# Naming conventions

House naming doctrine. One question, one answer:

> **What you type is kebab (`-`), what you call is snake (`_`), what you export is camel (nothing).**

If a rule is unclear or a name does not fit, change the relevant document — do
not silently invent a fourth style.

## Doctrine

| Area               | Document                                       | Covers                                                  |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------- |
| **Shell**          | [`naming/shell.md`](naming/shell.md)           | Function tiers, word order, verb vocabulary, file names |
| **TypeScript**     | [`naming/typescript.md`](naming/typescript.md) | Identifiers, CLI entry, module file names               |
| **Workflow files** | this document                                  | `.github/workflows/` filename grammar                   |

## Workflow files: `<namespace>--<loose-verb>[--<target>].yml`

Workflow files under `.github/workflows/` follow this grammar. The filename
encodes three segments separated by `--`:

```text
<namespace>--<loose-verb>[--<target>].yml
```

- `--` separates the segments; `-` joins words **within** a segment.
- **Loose verb**, not the tool: name the intent (`build`, `test`, `verify`,
  `publish`), never the binary that happens to do it.
- **Target is optional**: workflows without a scope are namespace + verb only
  (`defined--publish`, `defined--test`, `defined--verify`).

The gate's three workflow files:

```text
defined--verify.yml    defined--test.yml    defined--publish.yml
```

`defined--verify.yml` is the managed gate workflow `comply` installs into
consumer repos; it carries its own triggers and reads the gate version from the
consumer's `.defined.json`. It is **not** a reusable workflow, so no consumer
pins a gate ref. The other two are ordinary CI for this repo.

Consequences:

- The double hyphen makes the segment boundaries greppable and unambiguous:
  `rg '^defined--'` finds every gate workflow.
- A `--` inside a segment is impossible by construction, so single-hyphen
  namespaces/targets need no escaping.

## Scope and enforcement

This grammar covers tracked `.github/workflows/*.yml` and `*.yaml` files.
Internal modules (`runtime/steps/*.mts` where filename == step id, `lib/*.mts`
shared helpers) and `standards/` files are not part of the segmented scheme;
their names follow the shell/TypeScript doctrine above.

- **Workflow grammar** is mechanically enforced by the gate's `naming` step —
  always, over every tracked workflow file. A filename that breaks the grammar
  fails the gate.
- **Shell and TypeScript** rules are enforced by a project-supplied rules
  command, declared under the `.defined.json` `naming` key:

    ```json
    {
        "naming": {
            "command": "quality/naming.sh",
            "fix": "quality/naming.sh --fix"
        }
    }
    ```

    The `command` runs over the git scope and must exit non-zero on violations;
    the optional `fix` runs first in `comply` (fix) mode only. The gate provides
    the framework and the workflow grammar; projects bring their own doctrine.
