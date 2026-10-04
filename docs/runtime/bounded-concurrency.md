---
Area: runtime
Date: 2026-10-04
Keywords: comply.mts, runPass, bounded concurrency, scheduler, needs, uses, shared resources, deterministic reports, blocked, cancellation, AbortSignal, SIGINT, DEFINED_CONCURRENCY, issue 70
---

# Bounded concurrency and deterministic reports (`runtime/comply.mts`)

Issue #70 let independent verification steps run together without letting
dependent or conflicting work race. Claims are tagged per
`~/.config/opencode/EVIDENCE-TAGS.md`.

## What changed

`[FACT]` `runPass` used to await every step in a plain `for` loop. It now splits
by mode: the repair (`fix`) pass runs strictly sequentially, while verification
(`no-fix`) runs through a scheduler with bounded concurrency (`runScheduled`,
`runtime/comply.mts`). The published entry point and its result type are
unchanged — still a `Map<string, StepResult>`.

`[FACT]` Two optional fields were added to the orchestrator's `Step` contract:

- `needs?: readonly string[]` — prerequisite step ids. A prerequisite that did
  not pass (nor skip cleanly) blocks the dependent rather than letting it run on
  half-restored state. The dependent gets `blocked({ message })` and never runs.
- `uses?: readonly string[]` — named mutable resources, as mutual-exclusion
  keys. Two steps sharing one never overlap; a resource is **not** a dependency
  edge, so it constrains concurrency without forcing order.

## The schedule

`[FACT]` Declared edges and resources in `STEPS`:

| step                     | needs       | uses               |
| ------------------------ | ----------- | ------------------ |
| `naming`                 | —           | `consumer-command` |
| `node-deps`              | —           | —                  |
| `node`                   | `node-deps` | —                  |
| `eslint`                 | `node-deps` | —                  |
| `node-checks`            | `node-deps` | `consumer-command` |
| `node-coverage`          | `node-deps` | `consumer-command` |
| `dotnet`                 | —           | `consumer-command` |
| `dotnet-coverage`        | `dotnet`    | `consumer-command` |
| `shell`, `smoke`, `yaml` | —           | —                  |
| `workflow`               | —           | —                  |
| `tofu`                   | —           | `consumer-command` |

`[INFERRED]` `consumer-command` is held by every step that runs an arbitrary
consumer-defined command or the consumer's own build/test toolchain, so those
commands stay sequential by default (the plan's rule). `node-deps` is
deliberately **not** behind it: its install contract is to materialise
`node_modules/`, a path no other step writes, and the node family already waits
on it via `needs`; taking the global mutex would needlessly serialise it against
`dotnet`. The gate's own tools whose writes are disjoint (`node`/prettier,
`eslint`, `shell`, `yaml`, `workflow`, `smoke`) take no resource and overlap.

`[FACT]` The bound is `DEFAULT_CONCURRENCY = 4`, overridable by the
`DEFINED_CONCURRENCY` env var (a positive integer; anything else falls back to
the default) and by the `concurrency` option on `runPass` for tests. A bad value
can never wedge or crash a run (`resolveConcurrency`).

`[INFERRED]` `runPass`'s ready-set loop launches, in step order, every step whose
`needs` are satisfied and whose `uses` resources are free, up to the bound; it
then awaits the first completion and repeats. A dependency cycle or otherwise
unsatisfiable schedule is detected (no progress with nothing in flight) and the
remaining steps are marked `error` rather than spinning.

## Deterministic reports

`[FACT]` The results `Map` is pre-initialised in `steps` order and keyed by id,
so overwriting a value as a step completes never changes key order. The report
is therefore identical whatever the completion order. Step timings are collected
as the steps settle and emitted in `steps` order, so `--timings` stderr stays
deterministic too (`emitTimings`).

## Cancellation

`[FACT]` `cancellableRunner` wraps `run` (lib/proc.mts) so every child a step
spawns inherits the pass's `AbortSignal`. `main()` installs `SIGINT`/`SIGTERM`
handlers wired to an `AbortController` and removes them afterwards. On abort: no
further step is launched, running children are `SIGKILL`ed (the process-group
kill from #69), and any still-pending step is recorded as
`error` with `"<id>: cancelled before start"`. The gate still prints its JSON
result and exits non-zero.

`[FACT]` The runner is injected via `StepInput.runner`; a step called directly in
a test without one falls back to its `runner = run` default, so direct step tests
are unchanged.

## Traps for the next agent

`[FACT]` **The resource model is opt-in.** A new step that writes a shared path
and declares neither `uses` nor `needs` will overlap freely. Add `uses` for a
shared mutable resource and `needs` for a prerequisite.

`[RISK]` **Cancellation is cooperative for a step that ignores its runner.** The
scheduler stops _launching_ and the injected runner kills _children_, but a step
awaiting a promise that is not a child process is not force-stopped. Today every
long-running step awaits a runner call, so this is theoretical.

`[RISK]` `[NEEDS INVESTIGATION]` The wall-clock benefit is not measured — the
proof is the fake-step bound/stress test, not a benchmark. `--timings` on a real
polyglot repo is the measurement to take.

`[FACT]` **The gate does not typecheck** (see
`docs/runtime/async-process-runner.md`); a strict `tsc` pass over the changed
surface is still the check a type slip would need.

## Verification (2026-10-04, #70 working tree)

`[FACT]` `node --test 'cli/*.test.mts' 'lib/*.test.mts'
'runtime/**/*.test.mts'` → **465 pass, 0 fail** (includes the podman container
e2e; 11 new orchestrator tests cover overlap, resource exclusion, the bound,
blocked dependents, completion-order determinism, sequential repair, both
cancellation paths, the runner signal seam and the env overlay).

`[FACT]` `./runtime/comply.sh` → `{"status":"compliant"}` with the gate itself
now running its verification steps concurrently.
