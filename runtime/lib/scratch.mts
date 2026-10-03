// lib/scratch.mts — no-fix scratch workspace for steps that must write.
//
// Several steps write into the working tree: the node family restores
// node_modules/ and coverage reports, the dotnet family writes obj/, bin/ and
// TestResults/, and tofu init writes .terraform/ + a lock file. That is fine
// under `comply` (rw mount), but a read-only `verify` — local `defined verify`
// and every CI run mount the repo read-only — cannot write in place (findings
// #10, #20; issue #43). In no-fix mode those steps instead work in a scratch
// copy of the repo's git scope under /tmp: identical content, writable
// filesystem, repo mount untouched. Shared caches (the named volumes) are
// unchanged.

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Mutable box shared by the write-capable steps so one scratch serves a pass. */
export interface Scratch {
    /** Absolute scratch root; null until `ensureScratch` creates it. */
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
        const src = join(repoRoot, rel);
        // A repair may have deleted or renamed a path since the inventory was
        // taken, so copy only what still exists: a stale path must degrade to
        // "absent from the copy", never abort the whole no-fix pass (#62).
        if (!existsSync(src)) {
            continue;
        }
        const dest = join(dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest);
    }
    if (scratch) {
        scratch.dir = dir;
    }
    return dir;
}

/**
 * The directory a write-capable step should work in: the repo itself for fix
 * mode, the shared /tmp scratch copy for no-fix. Every step that touches the
 * working tree (formatting, checks, coverage, dotnet builds) calls this, so a
 * pass has exactly one working root and dependency restore lands where the
 * commands that need it will look (issue #40).
 *
 * `repoWritable` overrides the no-fix scratch for a write-capable invocation
 * (`comply`): a report the consumer must keep — the coverage artifact SonarQube
 * reads — is written into the repo, not a scratch that is discarded. A
 * read-only `verify` leaves it false, so the repo mount is never written.
 */
export function resolveWorkingRoot({
    mode,
    repoRoot,
    scratch,
    files,
    repoWritable = false,
}: {
    mode: "fix" | "no-fix";
    repoRoot: string;
    scratch?: Scratch;
    files: string[];
    /** Work in the repo even in no-fix (a write-capable invocation). */
    repoWritable?: boolean;
}): string {
    return mode === "fix" || repoWritable
        ? repoRoot
        : ensureScratch({ scratch, repoRoot, files });
}

/** Remove a scratch dir created by ensureScratch. No-op when none exists. */
export function cleanupScratch(scratch: Scratch | null | undefined): void {
    if (scratch?.dir) {
        rmSync(scratch.dir, { recursive: true, force: true });
        scratch.dir = null;
    }
}
