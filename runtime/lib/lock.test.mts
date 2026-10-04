// Tests for lib/lock.mts: the per-checkout comply lock (#75). Real files in a
// temp dir, because the lock's whole job is filesystem atomicity and staleness.
// Run: node --test lib/lock.test.mts

import assert from "node:assert/strict";
import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { cleanupTempDirs, makeTempDir } from "../test-helpers.mts";
import { acquireLock, LOCK_FILE, type LockInfo } from "./lock.mts";

afterEach(cleanupTempDirs);

function info(startedAt: string = new Date().toISOString()): LockInfo {
    return {
        pid: 4321,
        startedAt,
        checkout: "/repo",
        command: "comply",
    };
}

test("one holder excludes a second acquire; release frees the checkout", async () => {
    const dir = await makeTempDir("defined-lock-");
    const first = acquireLock({ gitDir: dir, info: info(), repoRoot: dir });
    assert.equal(first.kind, "acquired");
    if (first.kind !== "acquired") {
        return;
    }
    try {
        assert.equal(existsSync(join(dir, LOCK_FILE)), true);

        const second = acquireLock({
            gitDir: dir,
            info: info(),
            repoRoot: dir,
        });
        assert.equal(second.kind, "busy");
        if (second.kind === "busy") {
            assert.equal(second.lock.command, "comply");
            assert.equal(second.lock.pid, 4321);
        }
    } finally {
        first.handle.release();
    }

    assert.equal(
        existsSync(join(dir, LOCK_FILE)),
        false,
        "release removes the lock file",
    );
    const third = acquireLock({ gitDir: dir, info: info(), repoRoot: dir });
    assert.equal(third.kind, "acquired");
    if (third.kind === "acquired") {
        third.handle.release();
    }
});

test("a lock older than the stale window is reclaimed", async () => {
    const dir = await makeTempDir("defined-lock-");
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, JSON.stringify(info("2000-01-01T00:00:00.000Z")));
    utimesSync(path, new Date(0), new Date(0));

    const result = acquireLock({
        gitDir: dir,
        info: info(),
        repoRoot: dir,
        staleMs: 1000,
    });
    assert.equal(result.kind, "acquired");
    if (result.kind === "acquired") {
        result.handle.release();
    }
});

test("a malformed lock file is reclaimed rather than trusted", async () => {
    const dir = await makeTempDir("defined-lock-");
    writeFileSync(join(dir, LOCK_FILE), "not json");

    const result = acquireLock({ gitDir: dir, info: info(), repoRoot: dir });
    assert.equal(result.kind, "acquired");
    if (result.kind === "acquired") {
        result.handle.release();
    }
});

test("the holder refreshes the lock mtime so a live run is not reclaimed", async () => {
    const dir = await makeTempDir("defined-lock-");
    const path = join(dir, LOCK_FILE);
    const result = acquireLock({
        gitDir: dir,
        info: info(),
        repoRoot: dir,
        heartbeatMs: 10,
    });
    assert.equal(result.kind, "acquired");
    if (result.kind !== "acquired") {
        return;
    }
    try {
        utimesSync(path, new Date(0), new Date(0));
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(
            statSync(path).mtimeMs > 0,
            "heartbeat should have refreshed the mtime",
        );
    } finally {
        result.handle.release();
    }
});

test("busy reports git-scope files edited after the run started", async () => {
    const dir = await makeTempDir("defined-lock-");
    const startedAt = new Date(Date.now() - 10_000);
    const held = acquireLock({
        gitDir: dir,
        info: info(startedAt.toISOString()),
        repoRoot: dir,
    });
    assert.equal(held.kind, "acquired");
    if (held.kind !== "acquired") {
        return;
    }
    try {
        writeFileSync(join(dir, "old.ts"), "old");
        writeFileSync(join(dir, "fresh.ts"), "fresh");
        utimesSync(
            join(dir, "old.ts"),
            new Date(startedAt.getTime() - 1000),
            new Date(startedAt.getTime() - 1000),
        );

        const busyResult = acquireLock({
            gitDir: dir,
            info: info(),
            repoRoot: dir,
            files: ["old.ts", "fresh.ts", "gone.ts"],
        });
        assert.equal(busyResult.kind, "busy");
        if (busyResult.kind === "busy") {
            assert.deepEqual(busyResult.newerThanRun, ["fresh.ts"]);
        }
    } finally {
        held.handle.release();
    }
});
