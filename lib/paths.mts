// lib/paths.mts — shared path resolution.
//
// Symlink resolution and repo-root derivation — generic building blocks
// shared by the runtime (quality gate). Never imports steps; steps and the
// orchestrator import this.
//
// Public functions take a single destructured object (named-parameter style).

import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Resolve symlinks in a path, returning the real filesystem location. */
export function resolveRealPath({ path }: { path: string }): Promise<string> {
    return realpath(path);
}

/**
 * Derive the repo root by walking up from startDir until a `.git` marker
 * (directory or worktree file) is found. Symlinks in startDir are resolved
 * first so linked invocations report the true root.
 *
 * Throws when no marker exists up to the filesystem root.
 */
export async function deriveRepoRoot({
    startDir,
}: {
    startDir: string;
}): Promise<string> {
    let current = await resolveRealPath({ path: resolve(startDir) });

    while (true) {
        if (existsSync(join(current, ".git"))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            throw new Error(
                `no .git found above ${startDir} — not inside a git repository`,
            );
        }
        current = parent;
    }
}
