# YAML standards

The gate lints tracked `*.yml` / `*.yaml` with **yamllint** and formats YAML
with **prettier** (the `node` step). Both run over the repo's git scope.

## yamllint

- The gate passes its own config explicitly
  (`runtime/config/yamllint.yml`), so the rules travel with the image and never
  depend on the consumer's working directory.
- It runs with `-s`: **warnings are failures**. The bar is identical locally
  (`defined comply`) and in CI (`defined verify`).
- Findings are reported as a count (`yaml: N yamllint finding(s)`). There is no
  autofix — YAML formatting is prettier's job.

The travelling config extends yamllint's defaults with a few deliberate
relaxations:

| Rule             | Setting                      | Why                                       |
| ---------------- | ---------------------------- | ----------------------------------------- |
| `line-length`    | `max: 120`                   | GitHub Actions and compose lines run long |
| `document-start` | disabled                     | workflow/config snippets often omit `---` |
| `truthy`         | allows `on`                  | GitHub Actions' `on:` key                 |
| `comments`       | `min-spaces-from-content: 1` | matches prettier's output                 |

## Formatting

Prettier formats YAML as part of the `node` step, so the linter and the
formatter agree rather than fight. See [`naming.md`](naming.md) for the
workflow filename grammar.
