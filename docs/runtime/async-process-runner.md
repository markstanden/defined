---
Area: runtime
Keywords: proc.mts, async runner, spawnSync, child_process, CommandResult, timeout, cancellation, AbortSignal, bounded capture, truncation, process group, SIGKILL, failureDetail, invokeEslint, S7503, issue 69, issue 70
Summary: Why the gate's runner became async (#69) — the `CommandResult` contract, process-group kill, head+tail capture, failure classification, the async ripple, and the "gate doesn't typecheck" trap.
---

# The async process runner (`lib/proc.mts`)

> Split plan: the runner contract and kill semantics; the async ripple and the "gate doesn't typecheck" trap.

Issue #69 replaced the gate's blocking `spawnSync` runner with an injectable
asynchronous one. This doc records the contract, the mechanics worth not
re-deriving, and the traps hit along the way. Claims are graded by section:
**Facts** (observed, cited), **Inferred** (reasoned), **Tested** (reproduced),
**Open questions**.

## Why it changed

### Facts

- The pre-#69 runner used `spawnSync`, which blocks the event loop for
  the whole command and has no timeout or cancellation contract — stated in the
  issue body (`gh issue view 69`, source `lib/proc.mts` at `0de7ef4`, L22–L46).
- Relabelling the old wrapper `async` would not have given real
  concurrency: `Promise.all` around `spawnSync` calls still serialises, because
  each call blocks the loop while it runs. This is why #70 (bounded concurrency)
  hard-depends on #69.

## The result contract

### Facts

- `run(options, spawnFn?)` returns a `Promise<CommandResult>`
  (`lib/proc.mts:259`). `CommandResult` has required fields
  (`lib/proc.mts:30`):

    - `status: number | null` — exit code; null when signalled or never exited
    - `stdout`, `stderr: string` — bounded captures
    - `signal: NodeJS.Signals | null` — terminating signal, null on normal exit
    - `timedOut: boolean` / `cancelled: boolean` — why the child was killed
    - `truncated: boolean` — either stream exceeded the cap

- Fields are **required**, not optional: a `satisfies CommandResult` fake
  must set all seven, so a half-built fake fails to compile rather than silently
  mis-reporting an outcome. This bit every test fake in the #69 change; see the
  fakes listed under "Widening the seam" below.

## Async spawn, injectable seam

### Facts

- Production spawns with `stdio: ["ignore", "pipe", "pipe"]` and
  `detached: true` (`lib/proc.mts:274`, `:277`); output is consumed via stream
  `data` events, not a synchronous buffer.
- The spawn function is the second parameter — `SpawnFn = typeof spawn`
  (`lib/proc.mts:48`, `:269`) — so tests drive timeout, cancellation and capture
  deterministically through a `FakeChild` (`lib/proc.test.mts:36`) and a
  `spawnThat` seam (`lib/proc.test.mts:53`). No real sleeps in the fake cases.

## Process groups (descendants die with the parent)

### Facts

- A child is spawned `detached`, so it leads its own process group;
  timeout and cancellation send `SIGKILL` to the **whole group** via
  `process.kill(-pid, "SIGKILL")`, falling back to `child.kill("SIGKILL")` when
  the group signal fails (`terminate`, `lib/proc.mts:153`; `signalGroup`,
  `lib/proc.mts:161`).
- The timeout test proves the group kill and not just the parent: it
  runs `sh -c "sleep 30"` with `timeoutMs: 150` and resolves promptly
  (`lib/proc.test.mts:122`). Killing only the shell would leave the `sleep`
  descendant holding the pipe open, so `close` would not fire — the test would
  hang for 30s. Prompt resolution is the evidence the descendant died too.

## Bounded capture (head + tail, never the whole spill)

### Facts

- Per-stream cap defaults to `DEFAULT_MAX_OUTPUT_BYTES = 1_048_576`
  (1 MiB, `lib/proc.mts:22`), overridable per run via `maxOutputBytes`
  (`lib/proc.mts:64`).
- Past the cap the capture keeps the head (60%) and the most recent tail,
  joined by an explicit `TRUNCATION_MARKER` (`\n…[output truncated]…\n`,
  `lib/proc.mts:25`), and sets `truncated: true` (`createCapture`,
  `lib/proc.mts:82`; `HEAD_FRACTION = 0.6`, `:28`).

### Inferred

- Head-and-tail (rather than head-only) is the choice that keeps a
  failure summary legible: a compiler or test runner usually prints its final
  verdict last, so a head-only capture would discard the one line a reader needs.
  The code makes this choice explicitly; the reasoning is stated in the module
  header comment, not proven by a dedicated test.

## Failure classification

### Facts

- `failureDetail({ result })` renders a result as actionable text,
  preferring stdout then stderr, and prefixes a non-plain outcome
  (`lib/proc.mts:302`; `outcomeLabel`, `:313`). Verified outputs
  (`lib/proc.test.mts:178`):

    | Outcome      | Rendered                                 |
    | ------------ | ---------------------------------------- |
    | clean exit   | the output alone (no prefix)             |
    | nonzero exit | `exit 3: boom`                           |
    | signal       | `killed by SIGKILL: no output`           |
    | timeout      | `timed out: no output`                   |
    | cancellation | `cancelled: no output`                   |
    | never exited | `did not exit: no output`                |
    | truncated    | any of the above + ` (output truncated)` |

- Missing binaries still **throw** (reject), naming the binary and the
  Containerfile remedy (`startError`, `lib/proc.mts:137`; asserted
  `lib/proc.test.mts:80`). This preserves the no-optional-tier policy: a tool the
  image should contain must exist, and its absence is a Containerfile problem, not
  a soft failure.

## Cancellation

### Facts

- An `AbortSignal` aborts the child (`onAbort`, `lib/proc.mts:211`); an
  already-aborted signal kills immediately without waiting (`lib/proc.mts:222`;
  test `lib/proc.test.mts:151`).

## Widening the seam (the async ripple)

### Facts

- Every step already took its runner injected, so the change was to widen
  the injected type from a sync result to the async one and `await` at each call
  site. Touched production files (git diff of the #69 change):
  `lib/git.mts` (`trackedFiles` became async), `runtime/setup.mts`,
  `runtime/lib/node-packages.mts`, `runtime/lib/coverage.mts`,
  `runtime/lib/fixture.mts`, `runtime/comply.mts`, and steps `naming`, `node`,
  `eslint`, `node-checks`, `node-coverage`, `dotnet-coverage`, `dotnet`, `tofu`,
  `workflow`, `yaml`, `shell`.
- `invokeEslint` was left deliberately **non-async** — it returns the
  promise rather than awaiting — to avoid Sonar `S7503` (a function marked
  `async` with no `await`). This is the same S7503 tension parked in the Sonar
  sweep; keep the function returning the promise, not `async`.
- Test fakes were updated to async and to set all seven `CommandResult`
  fields: `runtime/test-helpers.mts`, `runtime/steps/naming.test.mts`,
  `runtime/steps/node-coverage.test.mts`,
  `runtime/steps/dotnet-coverage.test.mts`.

## Latent bug fixed in passing

### Facts

- `tofu.mts`'s `tflint --fix` handling treated anything other than exit 0
  or 2 as a failure. Before #69 a signalled run surfaced as a `status` that the
  old code could read as success; the new runner gives `status: null` +
  `signal` for a killed child, which the fixed guard rejects (`runtime/steps/tofu.mts`,
  the `tflint --fix` branch).

### Inferred

- The old sync path rarely signalled, so the hole was latent rather than observed
  in the field.

## Verification (2026-10-04, `main @ acd605a` + #69 working tree)

### Facts

- `node --test 'cli/*.test.mts' 'lib/*.test.mts'
'runtime/**/*.test.mts'` → **454 pass, 0 fail** (includes the podman container
  e2e, ~62s).
- `./runtime/comply.sh` → `{"status":"compliant"}`, no repairs written.
- A strict `tsc --noEmit` over the changed `.mts` surface (types from the
  TypeScript cache, since the host has no `@types/node`) reports only four errors,
  and those four **already exist on `main`** — confirmed by typechecking a clean
  `git archive main` export and seeing the same errors at shifted line numbers:
  `comply.mts` `repoRoot` not in `ShellRunContext`/`YamlRunContext`,
  `node-packages.mts:91` possibly-undefined call, `naming.mts:131`
  `string | undefined`.

### Inferred

- They are loose-typing drift, not #69 regressions — the line shifts line up with
  the async edits but the errors do not depend on them.

## Traps for the next agent

### Facts

- **The gate does not typecheck.** Node runs the `.mts` files with
  strip-types, and the gate has no `tsc` step, so a leftover un-`await`ed call
  site — or a `Promise` used where a value is expected — passes the gate. The
  #69 sweep caught none, but a strict `tsc` pass over the changed files is the
  check that would have caught them; the host `tsc` needs a `--typeRoots`/
  `--types node` override to an `@types/node` copy.
- **`CommandResult` fields are required.** Adding a fake that omits
  `signal`/`timedOut`/`cancelled`/`truncated` fails to compile under `satisfies`.
- The `signalGroup` catch branch and the `startError` non-`Error` branch are
  defensive fallbacks with no dedicated test — acceptable coverage-wise, but
  unproven.

### Open questions

- Do they need a case, or is the branch genuinely unreachable in the gate's usage?

## What this unblocks

### Facts

- #70 (bounded concurrency + deterministic reports) hard-depends on
  #69 — you cannot run steps concurrently while the runner blocks the loop.
- The #72 result contract's `error`/`blocked` semantics get real meaning
  once a command can be timed out, cancelled or signalled rather than only
  exiting nonzero (`failureDetail`).
