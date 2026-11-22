---
Area: runtime
Keywords: coverage minimums, property-based tests, fast-check, float boundary, checkMinimums, node_modules volume, coverage.satisfies
Summary: An exact-boundary defect in the coverage gate, the property test that found it, and how a test dev dependency reaches the suite inside the container.
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
- `node --test` (606 pass) and `./runtime/comply.sh`
  (`{"status":"compliant"}`) on 2026-11-22.

## Open questions

- The failure message still renders coverage with `toFixed(1)`, so a genuine
  near-boundary failure (28.96% against a 29% minimum) still prints
  `29.0% < 29% minimum`. Cosmetic; needs a decision on precision or fraction
  display.
- Fractional minimums (config accepts any number 0–100) still compare in float;
  `hit * 100 >= minimum * found` is far tighter but not exact for arbitrary
  decimal literals.

## Failed approaches

- Boundary generation with `Math.round((minimum * found) / 100)` plus an offset
  of `-2..2` over arbitrary denominators: the misround set is sparse (~0.04% of
  pairs), so 100 runs still passed.
- A denominator of 250: fractional `hit`, rejected as a malformed counter.
