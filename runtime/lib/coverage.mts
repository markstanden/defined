// lib/coverage.mts — shared plumbing for the coverage steps.
//
// node-coverage and dotnet-coverage both run the consumer's coverage command,
// then parse the report it writes. A read-only `verify` cannot write into the
// repo, so no-fix runs the command against a scratch copy of the git scope under
// /tmp (shared across steps via ctx.scratch) and parses the report from there;
// fix mode runs in the repo. This module owns that shared command step so the
// two coverage steps differ only in config key, report format and parser.

import { failed, type StepResult } from "./step-result.mts";
import { ensureScratch, type Scratch } from "./scratch.mts";
import { run } from "../../lib/proc.mts";

type Runner = typeof run;

export interface CoverageCommandOutcome {
    /** Repo root (fix) or scratch dir (no-fix) the command ran in. */
    workingRoot: string;
    /** Non-null when the command failed; the step returns it verbatim. */
    failure: StepResult | null;
}

/**
 * Run the consumer's coverage command in the right working root: the repo for
 * fix mode, a shared /tmp scratch copy of the git scope for no-fix. Returns the
 * working root (so the caller parses the report from the same place) and a
 * failure result when the command exits non-zero.
 */
export function runCoverageCommand({
    mode,
    repoRoot,
    scratch,
    trackedFiles,
    command,
    label,
    runner,
}: {
    mode: "fix" | "no-fix";
    repoRoot: string;
    scratch?: Scratch;
    trackedFiles: string[];
    command: string;
    label: string;
    runner: Runner;
}): CoverageCommandOutcome {
    const workingRoot =
        mode === "no-fix"
            ? ensureScratch({ scratch, repoRoot, files: trackedFiles })
            : repoRoot;

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
        return {
            workingRoot,
            failure: failed({
                notice: `${label}: coverage command failed: ${detail || "no output"}`,
            }),
        };
    }

    return { workingRoot, failure: null };
}
