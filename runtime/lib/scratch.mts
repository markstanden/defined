// lib/scratch.mts — no-fix scratch workspace for steps that must write.
//
// The dotnet family (restore/build/test/coverlet) writes obj/, bin/ and
// TestResults/ into the repo. That is fine under `comply` (rw mount), but a
// read-only `verify` — local `defined verify` and every CI run mount the repo
// read-only — cannot build a dotnet repo in place (finding #10). In no-fix
// mode the dotnet steps instead work in a scratch copy of the repo's git
// scope under /tmp: identical content, writable filesystem, repo mount
// untouched. The shared NuGet cache (named volume) is unchanged.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Mutable box shared by the dotnet steps so one scratch serves a pass. */
export interface Scratch {
    dir: string | null;
}

/**
 * Return the scratch dir, creating it (and copying the git-scoped file list)
 * on first use. `files` are relative paths from repoRoot — exactly the gate's
 * file list — so the scratch is a faithful copy of the repo's git content.
 */
export function ensureScratch({
    scratch,
    repoRoot,
    files,
}: {
    scratch?: Scratch;
    repoRoot: string;
    files: string[];
}): string {
    if (scratch?.dir) {
        return scratch.dir;
    }
    const dir = mkdtempSync(join(tmpdir(), "defined-scratch-"));
    for (const rel of files) {
        const dest = join(dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(repoRoot, rel), dest);
    }
    if (scratch) {
        scratch.dir = dir;
    }
    return dir;
}

/** Remove a scratch dir created by ensureScratch. No-op when none exists. */
export function cleanupScratch(scratch: Scratch | null | undefined): void {
    if (scratch?.dir) {
        rmSync(scratch.dir, { recursive: true, force: true });
        scratch.dir = null;
    }
}
