// lib/proc.mts — child-process execution for gate steps.
//
// Thin, synchronous wrapper so steps never touch child_process directly.
// Missing binaries throw loudly (naming the binary) rather than returning
// a soft failure — per the no-optional-tier policy: a tool the image should
// contain must exist, and its absence is a Containerfile problem.

import { spawnSync } from "node:child_process";

export interface CommandResult {
    status: number;
    stdout: string;
    stderr: string;
}

export type Runner = typeof run;

/**
 * Run a command synchronously and capture its output.
 * Throws with guidance when the binary itself cannot be executed.
 */
export function run({
    cmd,
    args = [],
    cwd,
    env,
}: {
    cmd: string;
    args?: string[];
    cwd?: string;
    /** Full child environment; omitted means inherit the parent's. */
    env?: NodeJS.ProcessEnv;
}): CommandResult {
    const result = spawnSync(cmd, args, { encoding: "utf8", cwd, env });
    if (result.error) {
        const reason =
            (result.error as NodeJS.ErrnoException).code === "ENOENT"
                ? "not found in container — add it to runtime/Containerfile"
                : result.error.message;
        throw new Error(`cannot run '${cmd}': ${reason}`);
    }
    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}
