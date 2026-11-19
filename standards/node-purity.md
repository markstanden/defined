# House purity and CQS

Opt-in, image-owned checks for two independent contracts: a **pure module**
takes no runtime dependency, reads no enumerated ambient effect and does not
mutate its inputs; a **declared command** returns no value, and a **declared
query** writes no observable state. Nothing runs until `.defined.json` opts in.

The checks reuse the pinned ESLint engine and TypeScript parser, but not the
consumer's ESLint setup: `eslint.disable`, a repo-owned `eslint.config.*`, its
`ignores`/rules, inline disable comments and restored dependencies do not affect
this step. There is no cache in v1, so a policy, source or parser change cannot
replay a stale green.

## Enable it

The config example lives in the README (`purity` key); each list works alone.
The short version:

```json
{
    "purity": {
        "pureModules": ["lib/system-status.mts", "lib/derive/**/*.ts"],
        "commands": [{ "file": "lib/receipts.mts", "name": "saveReceipt" }],
        "queries": [{ "file": "lib/receipts.mts", "name": "readReceipt" }]
    }
}
```

- `pureModules` is a list of **positive** repo-relative paths or globs:
  `*` matches within one segment, `**` spans zero or more whole segments, `?`
  matches one non-separator character. Every selector must match at least one
  supported in-scope JS/TS file; overlap is deduped.
- `commands`/`queries` name exact repo-relative JS/TS files and local top-level
  binding names. Both strings and the file extension are validated.
- Omission opts out. An empty object opts out. The same `file` + `name` cannot
  be both a command and a query.
- Selection is against the gate's normal git scope: tracked plus untracked,
  non-ignored files. An ignored file is outside the scope, so a selector for it
  matches nothing (a configuration error, not a pass).

## The rules

| rule id               | contract                                                                                                                     | rejected                                                                                                                                                                                                                                                       | allowed                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defined/pure-module` | a selected file takes no runtime Node built-in edge, no loader, no ambient effect, and does not write a parameter's property | bare/`node:` built-in imports and re-exports, side-effect imports, empty `export {} from`, dynamic `import()`, ambient `require`, runtime `import x = require()`, the ambient globals below, `Date()`/`new Date()`/`Date.now`/`Math.random`, `input.count = 1` | type-only imports/exports, static imports of ordinary dependencies, relative pure helpers, `Math.max`, `new Date(0)`, `Date.parse`, shadowed names, local accumulators |
| `defined/cqs-command` | a declared command returns no value                                                                                          | `return value`, expression-bodied arrows, async payloads, `return undefined` where `undefined` is shadowed                                                                                                                                                     | fallthrough, bare `return`, unshadowed `return undefined`, `return void call()`; returns inside nested callbacks                                                       |
| `defined/cqs-query`   | a declared query writes no parameter property, captured binding or ambient global                                            | `input.count = 1`, `state = value` on an outer/module binding, `delete`, `++`, `for…of` assignment to an outer binding                                                                                                                                         | reading external state, local accumulators, returning a calculated value                                                                                               |
| `defined/cqs-targets` | every declared symbol resolves to a supported, implemented top-level declaration                                             | missing symbol, overload signatures without an implementation, methods, generators, `let`/`var`-bound functions, non-callable values                                                                                                                           | top-level function declarations, const-bound arrows/function expressions, exported or private, async                                                                   |

The rules are deliberately distinct: a clock read in a declared query passes
CQS and fails if its file is also declared pure. A command that atomically
returns a receipt is outside the strict command list unless the owner elects to
change that contract — never drop an externally required return to satisfy the
gate.

## Pure modules: the dependency boundary

`defined/pure-module` rejects a **runtime** edge to any Node built-in, detected
with the pinned runtime's `module.isBuiltin` plus the `node:` namespace. That is
intentionally conservative: even deterministic built-ins such as `node:path`
are excluded. Put a small adapter outside the selected module and pass its
result in.

- Erased declarations are allowed: `import type …`, `export type …`, and an
  import/export whose every specifier is `type` (verified on the pinned
  TypeScript toolchain, which emits no runtime import for them).
- A side-effect-only `import "node:fs"` and an empty `export {} from "node:fs"`
  are runtime edges. TypeScript may elide the latter today; JavaScript does not,
  so the check stays conservative and rejects it.
- Mixed declarations are not exempted: one value specifier keeps the whole
  declaration a runtime edge.
- Static imports of ordinary (non-built-in) dependencies remain possible.
- A relative wrapper that imports a built-in is **not** visible to this check;
  that is the documented blind spot. Keep the adapter outside the selected
  module, or add an import-graph contract later.

Loaders are rejected wholesale in a pure module: every runtime `import()`
(literal or computed), the ambient CommonJS `require()`, and a runtime
TypeScript `import x = require(...)`. Locally bound identifiers named `require`
are left alone; type-only import-equals is erased and allowed.

## Ambient effects

Rejected when unresolved (or a parser-lib global with no local definition):

| effect                    | examples                                                               |
| ------------------------- | ---------------------------------------------------------------------- |
| process/console/fetch     | `process.env`, `console.log`, `fetch(url)`                             |
| timers                    | `setTimeout`, `setInterval`, `setImmediate`                            |
| clock                     | `Date()`, `Date(1)`, `new Date()`, `Date.now`                          |
| randomness                | `Math.random`                                                          |
| direct `globalThis` forms | `globalThis.process`, `globalThis["console"]`, `globalThis.Date.now()` |

Allowed: `Math.max`, `new Date(0)` and any `new Date(instant)`, `Date.parse`,
and any lexically shadowed name — a parameter named `process`, a destructured
local `Date`, or a local `Math` object. Binding resolution is scope-aware, so a
shadowed name is not an ambient read.

Limits: aliases (`const p = process`), indirect access (computed non-literal
keys, `eval`, `Function`), browser APIs beyond the list, and arbitrary helper
effects are not detected. This is not proof of purity.

## Writes and CQS

A **pure module** rejects direct property assignments, updates and deletes
rooted in a function parameter (`input.count = 1`, `input.count++`,
`delete input.count`, including destructuring assignment targets). Reassigning
the parameter binding itself and mutating a newly allocated local accumulator
are allowed: this is a check on caller-visible writes, not a ban on `let` or
loops.

A **query** additionally rejects a direct assignment, update or delete of a
captured binding — including a module-level `let` — or a property chain rooted
in it. Reads of external state, local accumulators and returning a calculated
value are fine.

Unchecked by design, and review work: writes through an alias
(`const alias = outer; alias.x = 1`), mutating method calls
(`input.items.push(x)`), `this`, module-state changes from a method call, and
an injected repository's own effects. A query calling `repo.read()` cannot be
proven read-only by syntax; the check only proves the specified subset of
observable writes.

A **command** rejects a value-bearing return, including an expression-bodied
arrow's implicit result and an async payload. A bare `return`,
`return undefined` (only when `undefined` is the unshadowed global) and
`return void expression` are accepted. Returns inside nested callbacks are that
callback's own returns and are excluded. This is a syntax contract: forwarding
an apparently void helper needs `return` replaced by a statement call, and the
appropriate `await` in async code. The gate never rewrites it for you.

Callers' contextual `void` types, explicit `void`/`Promise<void>` annotations
and `readonly` parameters are useful complements, not proof — a contextually
void callback can still return a value, and `readonly` is shallow.

## Supported grammar

- Top-level `function` declarations and `const`-bound arrow/function
  expressions, exported or private. `async` is supported.
- Overload signatures are resolved to their implemented declaration; a
  signature-only symbol is reported as never checked.
- Rejected in v1: class/object methods, generators, `let`/`var`-bound
  functions, and values that are not callable. `defined/cqs-targets` names the
  symbol and the supported forms rather than passing silently.

## How the step runs

The `purity` step is read-only and image-owned. It runs in the authoritative
no-fix pass used by both `comply` and `verify`; repair skips it. It selects the
git scope, invokes the baked ESLint once over the selected files with
`--no-config-lookup`, an explicit `--config`, and `--no-inline-config`, and
reports one diagnostic per finding with the stable rule id, file, line, column
and remedy. Parse errors, ignored selected files and tool failures are
execution errors, never a pass.

## Adoption

1. Select a **published** image SHA that contains this feature and pin it in
   `.defined.json` (`version`); merging the feature alone does not change a
   consumer pinned elsewhere.
2. Add the `purity` policy. Start with one genuine pure module, not a whole
   directory: pick the calculation the caller can feed.
3. Run `defined comply` (repair, then verification) and fix the remedy the
   diagnostic names — usually by moving the read to the caller or turning a
   query write into a command.
4. `defined explain defined/pure-module` (or `purity`, `defined/cqs-command`)
   serves this document offline from the pinned image.

A GitHub Release for the image is optional for this mechanism; a SHA-tagged
image published from `main` is sufficient.
