---
Area: runtime
Keywords: comply lock, defined.lock, busy, newerThanRun, exclusive create, heartbeat, stale lock, git dir, worktree, WSL, process.exit, finally, issue 75
Summary: Serialises concurrent `comply` runs on one checkout (#75) via an exclusive-create lock in the checkout's absolute git dir, a 30 s heartbeat / 3 min stale window, and a `busy` refusal carrying `newerThanRun`.
---

# Serializing `comply` per checkout (the checkout lock)

Issue #75: two `comply` runs sharing one checkout could rewrite the same files
and make each other's verdicts unreproducible. Claims are graded by section:
**Facts** (observed, cited), **Inferred** (reasoned), **Tested** (reproduced),
**Open questions**.

## The problem

### Facts

- `comply` bootstraps (writes managed files), repairs (mutates source) and then
  verifies the same tree. Nothing serialised two invocations: the launcher
  starts each in its own container, both mounting the checkout read-write.

### Inferred

- Concurrent repair passes can interleave writes to one path, and a repair in
  run A can invalidate the inventory run B already took. The damage is not a
  crash but an unreproducible result, which is worse for a gate.

## The lock

### Facts

- The lock is an exclusive-create file (`writeFileSync(..., { flag: "wx" })`,
  i.e. `O_EXCL`) at `<absolute-git-dir>/defined.lock` (`runtime/lib/lock.mts`,
  `acquireLock`; path from `lib/git.mts` `absoluteGitDir`).
- `git ls-files` never lists `.git/`, so the lock file can never enter the
  gate's own scope — the "location not gated" criterion. A run that leaves it
  behind still leaves a clean inventory.
- The lock payload is `{ pid, startedAt, checkout, command }` — `LockInfo` in
  `runtime/lib/lock.mts`.

### Inferred

- `--absolute-git-dir` resolves to the per-worktree git dir, so one worktree's
  lock does not serialise an independent worktree of the same repo. (The same
  property that makes the path worktree-specific is also why worktrees inside
  the container already depend on git resolving their `.git` pointer; the lock
  adds no new constraint here.)

## Staleness: heartbeat, not pid

### Facts

- The holder refreshes the lock file's mtime on a heartbeat every 30 s
  (`makeHandle`, `HEARTBEAT_MS`), and a lock untouched for 3 minutes is stale
  (`isStale`, `STALE_MS`). A stale or malformed file is reclaimed and the create
  retried, bounded by `RECLAIM_ATTEMPTS = 3` so two racers cannot spin.
- A `SIGKILL`ed run (or a killed container) cannot run its cleanup, so the lock
  survives until the 3-minute stale window. A live run whose event loop is
  blocked longer than 3 minutes would be falsely reclaimed; every long step
  awaits an async child, so this is theoretical today.

### Inferred

- A pid-liveness test ("pid dead ⇒ reclaim") would be wrong here: each run
  executes in its own container's pid namespace, so a pid written by run A is
  meaningless in run B — run B could read a live run's pid as dead and steal the
  lock. The pid is therefore informational only. This corrects the PLAN's
  original "pid dead or `startedAt` older than a ceiling" wording.

## Contention: the `busy` status

### Facts

- A second invocation does not wait. When `liveHolder` returns a live holder,
  `acquireLock` returns `{ kind: "busy", lock, newerThanRun }`;
  `acquireComplyLock` prints `renderBusyResult` (`runtime/lib/report.mts`) and
  exits 1 (`runtime/comply.mts`).
- `busy` is a third top-level status alongside `compliant` / `not_compliant`,
  carrying the holder's `lock` and `newerThanRun` — the git-scope files whose
  mtime is newer than the holder's `startedAt` (`newerThanRun`, stat-based; a
  deleted or malformed file never claims an edit).

### Inferred

- `newerThanRun` is the actionable part: empty means the running gate is judging
  the current code, so waiting is worthwhile; non-empty means the caller's edits
  are not in that run, so it must cancel and rerun rather than wait. Recording
  it only on contention keeps the cost off the happy path.

## Wiring and the `process.exit` trap

### Facts

- `acquireComplyLock` is called from `main` for the `comply` verb, after the
  inventory fetch and before `runGate`; the handle is released in a `finally`.
  Read-only `verify` takes no lock (it never mutates, and its mount is
  read-only, so it could not write `.git/` anyway). Both the installed launcher
  and the local `runtime/comply.sh` execute `runtime/comply.mts` inside the
  container, so both inherit the protection with no launcher change.
- Fix: `main` passes `deps.exitFn` that records the code instead of exiting, so
  the `finally` releases the lock, and only then does `main` exit. Any future
  cleanup held across a run must not sit behind `runGate`'s `process.exit`.

### Tested

- **Trap found by the container e2e:** `runGate` called `process.exit(1)` on a
  failing run, which terminates without unwinding, so `main`'s `finally` never
  ran and the lock was stranded. The very next invocation reported `busy` with
  the dead run's pid, against a check that should have judged fresh code. The
  fixture caught it:

    ```
    {"status":"busy","lock":{"pid":1,"startedAt":"...","checkout":"/repo","command":"comply"},"newerThanRun":[...]}
    ```

## Corrections

- The PLAN's #75 design said staleness was "pid dead **or** `startedAt` older
  than a generous ceiling". The pid half is unsound across container pid
  namespaces; the design shipped is heartbeat-only (above). The ceiling became a
  3-minute mtime window rather than a long fixed age.

## Verification

### Tested

- `node --test 'cli/*.test.mts' 'lib/*.test.mts' 'runtime/**/*.test.mts'` →
  **475 pass, 0 fail** (2026-10-04). New coverage: `runtime/lib/lock.test.mts`
  (exclusion, release/cleanup, stale reclaim, malformed reclaim, heartbeat
  refresh, `newerThanRun`), `lib/git.test.mts` (`absoluteGitDir`, incl. the
  non-repo throw), `runtime/comply.test.mts` (`acquireComplyLock` busy/acquired
  wiring), `runtime/lib/report.test.mts` (`renderBusyResult`).
- `node --test runtime/fixture.test.mts` → 3 pass, 0 fail (the podman e2e, which
  is what caught the `process.exit` trap).
- `./runtime/comply.sh` → `{"status":"compliant"}`; no `defined.lock` remains in
  `.git/`.

## Traps for the next agent

### Facts

- A lock whose payload is malformed, or whose mtime is old, is reclaimed rather
  than trusted — never add a "wait a while then assume dead" path.
- The heartbeat's guard against false reclaim is the 3-minute window. If a
  future step blocks the event loop for minutes, either shorten steps or widen
  `STALE_MS`; do not add a pid check.
- `verify` is deliberately unlocked. If a future change makes `verify` write to
  the checkout, it must take the same lock (and its mount must stop being
  read-only).

## Out of scope (candidate follow-ups)

- **Cancel-and-take-over** — refusing keeps the gate out of half-repaired trees.
- **`newerThanRun` cost** on a very large checkout under contention was not
  benchmarked: it stats the whole git scope once per refused caller.
