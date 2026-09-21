// lib/coverage.mts — shared plumbing for steps that run a consumer command.
//
// Coverage steps and the naming step all run a consumer-supplied command, then
// act on its exit code. A read-only `verify` cannot write into the repo, so
// no-fix runs the command against a scratch copy of the git scope under /tmp
// (shared across steps via ctx.scratch); fix mode runs in the repo. This module
// owns that shared command step so callers differ only in config key and what
// they do with the result.

import { resolveWorkingRoot, type Scratch } from "./scratch.mts";
import { run } from "../../lib/proc.mts";

type Runner = typeof run;

export interface ScopedCommandOutcome {
    /** Repo root (fix) or scratch dir (no-fix) the command ran in. */
    workingRoot: string;
    /** Failure detail when the command exited non-zero, else null. */
    failure: string | null;
}

/**
 * Run a consumer command in the right working root: the repo for fix mode, a
 * shared /tmp scratch copy of the git scope for no-fix. Returns the working
 * root (so the caller reads generated artifacts from the same place) and the
 * failure detail when the command exits non-zero.
 */
export function runScopedCommand({
    mode,
    repoRoot,
    scratch,
    trackedFiles,
    command,
    runner,
}: {
    mode: "fix" | "no-fix";
    repoRoot: string;
    scratch?: Scratch;
    trackedFiles: string[];
    command: string;
    runner: Runner;
}): ScopedCommandOutcome {
    const workingRoot = resolveWorkingRoot({
        mode,
        repoRoot,
        scratch,
        files: trackedFiles,
    });

    const result = runner({
        cmd: "sh",
        args: ["-c", command],
        cwd: workingRoot,
    });
    if (result.status !== 0) {
        // Show stdout first: test/build failures land there, while a stray
        // first-run banner or noise lands on stderr — stderr-first masks the
        // real failure.
        const detail = [result.stdout, result.stderr]
            .filter((s) => typeof s === "string")
            .map((s) => s.trim())
            .filter((s) => s !== "")
            .join("\n");
        return { workingRoot, failure: detail || "no output" };
    }

    return { workingRoot, failure: null };
}
