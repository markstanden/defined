// lib/coverage.mts — shared plumbing for the coverage steps: run a consumer
// command in the right working root, and format an exact ratio as a percentage.
//
// Coverage steps and the naming step all run a consumer-supplied command, then
// act on its exit code. A read-only `verify` cannot write into the repo, so
// no-fix runs the command against a scratch copy of the git scope under /tmp
// (shared across steps via ctx.scratch); fix mode runs in the repo. A
// write-capable comply sets `repoWritable`, so no-fix runs report-producing
// steps in the repo and the artifact survives for a scanner. This module owns
// that shared command step so callers differ only in config key and what they
// do with the result, plus `formatPercent` so both ecosystems print the same
// floored percentage.

import { resolveWorkingRoot, type Scratch } from "./scratch.mts";
import { run, failureDetail } from "../../lib/proc.mts";

type Runner = typeof run;

export interface ScopedCommandOutcome {
    /** Repo root (fix) or scratch dir (no-fix) the command ran in. */
    workingRoot: string;
    /** Failure detail when the command exited non-zero, else null. */
    failure: string | null;
}

/**
 * Run a consumer command in the right working root: the repo for fix mode, a
 * shared /tmp scratch copy of the git scope for no-fix — unless the invocation
 * is write-capable (`repoWritable`, comply), in which case no-fix also runs in
 * the repo so a report it must keep survives. Returns the working root (so the
 * caller reads generated artifacts from the same place) and the failure detail
 * when the command exits non-zero.
 */
export async function runScopedCommand({
    mode,
    repoRoot,
    scratch,
    trackedFiles,
    command,
    runner,
    repoWritable = false,
}: {
    mode: "fix" | "no-fix";
    repoRoot: string;
    scratch?: Scratch;
    trackedFiles: string[];
    command: string;
    runner: Runner;
    /** Work in the repo even in no-fix (a write-capable invocation). */
    repoWritable?: boolean;
}): Promise<ScopedCommandOutcome> {
    const workingRoot = resolveWorkingRoot({
        mode,
        repoRoot,
        scratch,
        files: trackedFiles,
        repoWritable,
    });

    const result = await runner({
        cmd: "sh",
        args: ["-c", command],
        cwd: workingRoot,
    });
    if (result.status !== 0) {
        return { workingRoot, failure: failureDetail({ result }) };
    }

    return { workingRoot, failure: null };
}

/**
 * A percentage from an exact ratio, floored at four decimal places (never
 * rounded up) so a printed value can never read as meeting a minimum the exact
 * comparison failed. Round values keep one decimal ("70.0"); only awkward
 * ratios grow digits ("28.96"). Inputs are non-negative integers — counters,
 * or an exact scaled decimal such as a Cobertura rate expressed as
 * `value / 10^scale`.
 */
export function formatPercent({
    numerator,
    denominator,
}: {
    /** Counted value (an exact non-negative integer). */
    numerator: number | bigint;
    /** Total counted (an exact non-negative integer); 0 reads as "0.0". */
    denominator: number | bigint;
}): string {
    const found = BigInt(denominator);
    if (found === 0n) {
        return "0.0";
    }
    // Ten-thousandths of a percent by exact integer division:
    // (numerator / denominator) * 100 * 10^4.
    const tenThousandths = Number((BigInt(numerator) * 1_000_000n) / found);
    const fixed = (tenThousandths / 10_000).toFixed(4);
    let end = fixed.length;
    while (end > 0 && fixed[end - 1] === "0") {
        end -= 1;
    }
    const trimmed = fixed.slice(0, end);
    return trimmed.endsWith(".") ? `${trimmed}0` : trimmed;
}
