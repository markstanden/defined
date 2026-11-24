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
//
// The copy is stability-bracketed on its source (the scan-vs-comply race and
// the guard are recorded in docs/runtime/warm-copy-stability.md).

import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Mutable box shared by the write-capable steps so one scratch serves a pass. */
export interface Scratch {
    /** Absolute scratch root; null until `ensureScratch` creates it. */
    dir: string | null;
}

/** One source subtree's stat identity, keyed by its relative path. */
export type TreeSnapshot = ReadonlyMap<string, string>;

/** How many copy attempts a drifting source gets before the pass errors. */
const SCRATCH_ATTEMPTS = 3;

/**
 * The stat identity of every entry under `root`, keyed by relative path.
 * A copy is faithful only when this map is identical before and after it; a
 * concurrent writer changes an entry, an mtime or a size in between.
 *
 * `lstat` is deliberate: a symlink is recorded as itself and never descended,
 * so a workspace link cannot walk the bracket into another tree or a cycle.
 *
 * @param root Absolute subtree root.
 * @returns Entry path → `mtimeMs:size`.
 */
export function snapshotTree(root: string): TreeSnapshot {
    const entries = new Map<string, string>();
    walkTree(root, "", entries);
    return entries;
}

/** Record one subtree level and recurse into real directories only. */
function walkTree(
    root: string,
    relative: string,
    entries: Map<string, string>,
): void {
    const absolute = relative === "" ? root : join(root, relative);
    const stats = lstatSync(absolute);
    entries.set(relative, `${stats.mtimeMs}:${stats.size}`);
    if (!stats.isDirectory()) {
        return;
    }
    for (const name of readdirSync(absolute)) {
        walkTree(root, relative === "" ? name : `${relative}/${name}`, entries);
    }
}

/**
 * The stat identity of exactly the listed files, keyed by relative path. A
 * missing file is recorded as missing, so the #62 skip (a path deleted since
 * the inventory) stays stable across a bracket while an appearing file is
 * drift.
 *
 * @param root Repository root the paths are relative to.
 * @param files Relative file paths.
 * @returns Entry path → `mtimeMs:size` or `missing`.
 */
export function snapshotFiles(
    root: string,
    files: readonly string[],
): TreeSnapshot {
    const entries = new Map<string, string>();
    for (const relative of files) {
        try {
            const stats = lstatSync(join(root, relative));
            entries.set(relative, `${stats.mtimeMs}:${stats.size}`);
        } catch {
            entries.set(relative, "missing");
        }
    }
    return entries;
}

/**
 * Whether two snapshots differ: the copy they bracket is unprovable.
 *
 * @param before The source's identity before the copy.
 * @param after The source's identity after the copy.
 * @returns True when any entry appeared, vanished or changed.
 */
export function treeChanged(
    before: TreeSnapshot,
    after: TreeSnapshot,
): boolean {
    if (before.size !== after.size) {
        return true;
    }
    for (const [path, identity] of before) {
        if (after.get(path) !== identity) {
            return true;
        }
    }
    return false;
}

/**
 * Return the scratch dir, creating it (and copying the git-scoped file list)
 * on first use. `files` are relative paths from repoRoot — exactly the gate's
 * file list — so the scratch is a faithful copy of the repo's git content.
 *
 * A read-only pass must copy a stable snapshot: the listed files are bracketed
 * by their stat identities, and a copy that raced a concurrent writer (a
 * comply repair) is discarded and retried. A source that never stabilises
 * throws — an errored pass naming the concurrent writer — so a torn scratch
 * never reads as a compliance finding.
 *
 * @param root0 the parameter object
 * @param root0.scratch The shared scratch box.
 * @param root0.repoRoot Repository root to copy from.
 * @param root0.files Relative paths to copy.
 * @param root0.copyFn The copy seam; tests inject a copy that races the source.
 * @returns The scratch directory.
 */
export function ensureScratch({
    scratch,
    repoRoot,
    files,
    copyFn = cpSync,
}: {
    scratch?: Scratch;
    repoRoot: string;
    files: string[];
    copyFn?: typeof cpSync;
}): string {
    if (scratch?.dir) {
        return scratch.dir;
    }
    for (let attempt = 1; attempt <= SCRATCH_ATTEMPTS; attempt++) {
        const dir = mkdtempSync(join(tmpdir(), "defined-scratch-"));
        if (copyStable({ dir, repoRoot, files, copyFn })) {
            if (scratch) {
                scratch.dir = dir;
            }
            return dir;
        }
        rmSync(dir, { recursive: true, force: true });
    }
    throw new Error(
        `scratch copy could not be stabilised: a concurrent writer (comply or a repair) is mutating ${repoRoot}; retry when it finishes`,
    );
}

/** Copy the listed files, then prove the source did not change underneath. */
function copyStable({
    dir,
    repoRoot,
    files,
    copyFn,
}: {
    dir: string;
    repoRoot: string;
    files: string[];
    copyFn: typeof cpSync;
}): boolean {
    const before = snapshotFiles(repoRoot, files);
    try {
        for (const relative of files) {
            const src = join(repoRoot, relative);
            // A repair may have deleted or renamed a path since the inventory
            // was taken, so copy only what still exists: a stale path must
            // degrade to "absent from the copy", never abort the whole no-fix
            // pass (#62).
            if (!existsSync(src)) {
                continue;
            }
            const dest = join(dir, relative);
            mkdirSync(dirname(dest), { recursive: true });
            copyFn(src, dest);
        }
    } catch {
        // A file vanishing mid-copy is drift, not a hard error: discard the
        // attempt and let the retry copy the settled source.
        return false;
    }
    return !treeChanged(before, snapshotFiles(repoRoot, files));
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
