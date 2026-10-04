# runtime — comply-checkout-lock

Keywords: comply lock, defined.lock, busy, newerThanRun, exclusive create, heartbeat, stale lock, git dir, worktree, process.exit finally, issue 75
What: serialises concurrent `comply` runs on one checkout (#75) via an exclusive-create lock in the checkout's absolute git dir, a 30 s heartbeat / 3 min stale window, and a `busy` refusal carrying `newerThanRun` → docs/runtime/comply-checkout-lock.md
