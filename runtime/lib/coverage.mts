// lib/coverage.mts — shared plumbing for steps that run a consumer command.
//
// Coverage steps and the naming step all run a consumer-supplied command, then
// act on its exit code. A read-only `verify` cannot write into the repo, so
// no-fix runs the command against a scratch copy of the git scope under /tmp
// (shared across steps via ctx.scratch); fix mode runs in the repo. A
// write-capable comply sets `repoWritable`, so no-fix runs report-producing
// steps in the repo and the artifact survives for a scanner. This module owns
// that shared command step so callers differ only in config key and what they
// do with the result.

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
