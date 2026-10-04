// lib/lock.mts — per-checkout serialization for `comply` (#75).
//
// A single writer per working tree. `comply` bootstraps, repairs and verifies
// the same checkout, so two concurrent runs can rewrite the same files and make
// each other's verdicts unreproducible. The lock is an exclusive-create file
// inside the checkout's git dir: never git-tracked, so it is not gated content,
// and per-worktree, so independent worktrees are never serialised.
//
// A second invocation does not wait. It returns the running invocation's
// identity plus the git-scope files edited after that run started, so an agent
// can tell whether waiting would even help. Staleness is time-based, not
// pid-based: the holder refreshes the lock's mtime on a heartbeat, so a live run
// is never reclaimed and a crashed one recovers within the stale window. The
// pid is recorded for information only — each run executes in its own
// container's pid namespace, so another run cannot test that pid's liveness.

import {
    readFileSync,
    statSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The lock file name inside the checkout's git dir. */
export const LOCK_FILE = "defined.lock";

/** A lock whose mtime is older than this is stale (the holder stopped). */
export const STALE_MS = 3 * 60_000;

/** How often the holder refreshes the lock's mtime. */
export const HEARTBEAT_MS = 30_000;

/** Reclaim attempts before giving up and reporting busy, to avoid a spin. */
const RECLAIM_ATTEMPTS = 3;

/** The running invocation's identity, as reported to a contended caller. */
export interface LockInfo {
    /** Holder's pid; informational — container pid namespaces make it unverifiable elsewhere. */
    pid: number;
    /** ISO timestamp the holder started, the reference for `newerThanRun`. */
    startedAt: string;
    /** Absolute path of the checkout the holder is gating. */
    checkout: string;
    /** The verb the holder is running (`comply`). */
    command: string;
}

/** An acquired lock: the held identity plus the release that frees it. */
export interface LockHandle {
    /** The lock file that was created. */
    path: string;
    /** The identity written into the lock. */
    info: LockInfo;
    /** Remove the lock and stop the heartbeat; idempotent. */
    release: () => void;
}

/** The outcome of an acquire attempt: the lock is now ours, or another holds it. */
export type AcquireLockResult =
    | { kind: "acquired"; handle: LockHandle }
    | {
          kind: "busy";
          /** The running invocation's identity. */
          lock: LockInfo;
          /** Git-scope files edited after that run started (see lock.mts header). */
          newerThanRun: string[];
      };

/** True when a filesystem error is the exclusive-create collision we expect. */
function isEexist(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "EEXIST"
    );
}

/** Parse a lock file into its identity, or null when unreadable/malformed. */
function readLock({ path }: { path: string }): LockInfo | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null) {
            return null;
        }
        const info = parsed as Partial<LockInfo>;
        if (
            typeof info.pid !== "number" ||
            typeof info.startedAt !== "string" ||
            typeof info.checkout !== "string" ||
            typeof info.command !== "string"
        ) {
            return null;
        }
        return info as LockInfo;
    } catch {
        // Absent, unreadable or malformed: treat as reclaimable, never as a
        // run we must wait on.
        return null;
    }
}

/** True when the lock file has not been touched within the stale window. */
function isStale({
    path,
    staleMs,
}: {
    path: string;
    staleMs: number;
}): boolean {
    try {
        return Date.now() - statSync(path).mtimeMs > staleMs;
    } catch {
        // Vanished between the failed create and the stat: reclaimable.
        return true;
    }
}

/**
 * The identity of a live holder we must wait on, or null when the existing file
 * is absent, malformed or stale — i.e. ours to reclaim.
 */
function liveHolder({
    path,
    staleMs,
}: {
    path: string;
    staleMs: number;
}): LockInfo | null {
    const existing = readLock({ path });
    if (existing === null) {
        return null;
    }
    return isStale({ path, staleMs }) ? null : existing;
}

/**
 * The git-scope files whose mtime is newer than the running invocation's
 * `startedAt` — edits that landed after the run began, so the run cannot judge
 * them. A malformed timestamp yields no claims (never a false "your code is
 * included"). A file deleted since the inventory was taken is skipped.
 */
function newerThanRun({
    repoRoot,
    files,
    startedAt,
}: {
    repoRoot: string;
    files: readonly string[];
    startedAt: string;
}): string[] {
    const since = Date.parse(startedAt);
    if (Number.isNaN(since)) {
        return [];
    }
    const edited: string[] = [];
    for (const file of files) {
        try {
            if (statSync(join(repoRoot, file)).mtimeMs > since) {
                edited.push(file);
            }
        } catch {
            // Deleted since the inventory: not part of the tree now.
        }
    }
    return edited;
}

/** Build the acquired handle: hold the exclusive file and refresh its mtime. */
function makeHandle({
    path,
    info,
    heartbeatMs,
}: {
    path: string;
    info: LockInfo;
    heartbeatMs: number;
}): LockHandle {
    const timer = setInterval(() => {
        try {
            const now = new Date();
            utimesSync(path, now, now);
        } catch {
            // Lost the file (reclaimed as stale): the heartbeat no longer
            // matters, and release still clears the timer.
        }
    }, heartbeatMs);
    // Never hold the process open just for the heartbeat.
    timer.unref();
    let released = false;
    return {
        path,
        info,
        release: () => {
            if (released) {
                return;
            }
            released = true;
            clearInterval(timer);
            try {
                unlinkSync(path);
            } catch {
                // Already gone.
            }
        },
    };
}

/** A busy result for a lock that outlived the reclaim attempts. */
function busy({
    info,
    repoRoot,
    files,
}: {
    info: LockInfo;
    repoRoot: string;
    files: readonly string[];
}): AcquireLockResult {
    return {
        kind: "busy",
        lock: info,
        newerThanRun: newerThanRun({
            repoRoot,
            files,
            startedAt: info.startedAt,
        }),
    };
}

/**
 * Take the per-checkout lock, or report the holder. Existing files are
 * reclaimed when stale/malformed (with a bounded retry, so two racers still let
 * exactly one exclusive create win), never when a live run holds them.
 *
 * `gitDir` is the checkout's absolute git dir (lib/git.mts `absoluteGitDir`);
 * `files` is the current git-scope inventory, used only for the busy report.
 */
export function acquireLock({
    gitDir,
    info,
    repoRoot,
    files = [],
    staleMs = STALE_MS,
    heartbeatMs = HEARTBEAT_MS,
}: {
    gitDir: string;
    info: LockInfo;
    repoRoot: string;
    files?: readonly string[];
    staleMs?: number;
    heartbeatMs?: number;
}): AcquireLockResult {
    const path = join(gitDir, LOCK_FILE);
    for (let attempt = 0; attempt < RECLAIM_ATTEMPTS; attempt++) {
        try {
            writeFileSync(path, `${JSON.stringify(info)}\n`, { flag: "wx" });
            return {
                kind: "acquired",
                handle: makeHandle({ path, info, heartbeatMs }),
            };
        } catch (err) {
            if (!isEexist(err)) {
                throw err;
            }
        }
        const holder = liveHolder({ path, staleMs });
        if (holder !== null) {
            return busy({ info: holder, repoRoot, files });
        }
        // Stale or malformed: drop it and retry. Two racers may both unlink;
        // the exclusive create above still elects a single winner.
        try {
            unlinkSync(path);
        } catch {
            // Already gone.
        }
    }
    // Contended by a live run that keeps winning the race: report it.
    return busy({
        info: readLock({ path }) ?? info,
        repoRoot,
        files,
    });
}
