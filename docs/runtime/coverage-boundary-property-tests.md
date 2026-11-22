---
Area: runtime
Keywords: coverage minimums, property-based tests, fast-check, float boundary, checkMinimums, Cobertura rate, node_modules volume, coverage.satisfies
Summary: An exact-boundary defect in both coverage steps (lcov counters and Cobertura rates), the fix and its tests, and how a test dev dependency reaches the suite inside the container.
---

# Coverage boundaries and property tests

## Facts

- `checkMinimums`/`compareMinimum` (`runtime/steps/node-coverage.mts`) compares
  coverage against an integer minimum. The float form
  `(hit / found) * 100 >= minimum` rounds below the threshold at exact
  boundaries: 29 of 100 lines at a 29% minimum computed
  `28.999999999999996`, failed a compliant repo, and printed the
  self-contradicting `line: 29.0% < 29% minimum` (the message rounds up).
- The fix compares exactly: `hit * 100 >= minimum * found` (integer arithmetic
  for integer counters and minimums), with `found === 0` passing only at a 0
  minimum.
- Minimums are integers 0–100 by contract: `loadConfig` rejects a fractional
  value (`must be an integer 0–100`). Without that guard the integer form is
  still float for decimals — 7 of 10,000 lines at a 0.07% minimum failed
  (`0.07 * 10000 = 700.0000000000001`) and printed
  `line: 0.07% (7/10000) < 0.07% minimum`, the same self-contradiction.
- The .NET step had the same defect through the Cobertura rate: `0.29 * 100` is
  `28.999999999999996`, so a 29% report failed a 29% minimum. `parseRate`
  (`runtime/steps/dotnet-coverage.mts`) keeps the rate as an exact decimal
  (`value / 10^scale`) and compares `value * 100 >= minimum * 10^scale`.
- Both ecosystems format percentages through one helper
  (`formatPercent`, `runtime/lib/coverage.mts`), so the failure message and the
  pass notice agree: `line: 89.9999% (0.899999) < 90% minimum` for Cobertura,
  `line: 28.96% (724/2500) < 29% minimum` for lcov.
- Failure messages show the exact counter pair and a floored four-decimal
  percentage — `line: 28.96% (724/2500) < 29% minimum` — derived by exact
  integer division, so the printed value can never read as meeting a minimum
  the verdict failed. Round values keep one decimal (`70.0%`), preserving the
  familiar output. A seed-pinned property pins that law.
- Seed-pinned fast-check properties now cover `checkMinimums`,
  `escapeRegexPath`, `tfDirectories`, `identityHash` and `writeMarkedBlock`.
- `fast-check` is a devDependency (`package.json`); `package-lock.json` pins it.
- Inside the shim the repo's `node_modules` is a named volume, so the container
  only sees the dependency once `node-deps` restores it. `.defined.json`
  declares the root package with a `tests` check and
  `coverage.node.satisfies` names that check, so node-checks skips the
  duplicate suite run (#66).

## Inferred

- A uniform counter generator is the wrong instrument for this unit: exact
  ratio equality is roughly a 1-in-100,000 event, and 100k uniform runs found
  nothing. Hits must be generated on the documented threshold, from round
  denominators (coverage totals are counted in hundreds).
- Generators must stay inside the documented viable set: a denominator of 250
  produced fractional hits, which the contract rejects as malformed, and the
  property failed for the wrong reason before the generator was fixed.

## Tested

- The promoted counterexample (`100` found, `29` hit, `29` minimum) fails
  against the pre-fix code and passes after it; the property fails after 46
  cases on the unfixed code.
- An independent enumeration of `found <= 5000` leaves zero disagreements with
  the exact oracle after the fix.
- `loadConfig` rejects fractional minimums (`0.07`, `90.5`) and still accepts
  the 0 and 100 boundaries.
- The Cobertura comparison fails against the float form and passes against the
  exact one; every integer minimum 0–100 is enumerated, because a sampled
  property missed the sparse 29/57/58 set.
- `node --test` (633 pass) and `./runtime/comply.sh`
  (`{"status":"compliant"}`) on 2026-11-22.

## Failed approaches

- Boundary generation with `Math.round((minimum * found) / 100)` plus an offset
  of `-2..2` over arbitrary denominators: the misround set is sparse (~0.04% of
  pairs), so 100 runs still passed.
- A denominator of 250: fractional `hit`, rejected as a malformed counter.
