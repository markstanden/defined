// lib/git.mts — git inventory for the quality gate.
//
// Scanning scope is git's: tracked files plus untracked-but-not-ignored files
// (decision #10). Untracked local scratch that is gitignored never fails a
// gate, and per-tool ignores handle committed-but-generated exceptions via
// config travelling in runtime/config/.
//
// The inventory is requested NUL-delimited (`-z`): git quotes unusual paths
// (spaces, quotes, tabs, non-ASCII, newlines) in its default line output, so a
// newline split silently drops or mangles them. A nonzero git exit is an
// execution failure — an empty/partial inventory must never read as a clean
// scope.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { run } from "./proc.mts";

/**
 * List files git considers part of the tree: tracked plus untracked but
 * not ignored, relative to the repo root. Tracked files deleted from the
 * working tree are excluded; symlinks appear as themselves. Throws when the
 * git inventory command itself fails.
 */
export function trackedFiles({ repoRoot }: { repoRoot: string }): string[] {
    const result = run({
        cmd: "git",
        args: ["ls-files", "-co", "--exclude-standard", "--deduplicate", "-z"],
        cwd: repoRoot,
    });
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout).trim() || "no output";
        throw new Error(
            `git ls-files failed (exit ${result.status}): ${detail}`,
        );
    }
    return result.stdout
        .split("\0")
        .filter((path) => path !== "" && existsSync(join(repoRoot, path)));
}
