// Tests for lib/cache.mts: the content-addressed per-file cache (#68).
// Run: node --test runtime/lib/cache.test.mts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
    createFileCache,
    hashFile,
    identityHash,
    partitionByHash,
    reportCacheMetric,
    resolveCacheDir,
    sha256Hex,
} from "./cache.mts";
import { cleanupTempDirs, makeTempDir } from "../test-helpers.mts";

afterEach(cleanupTempDirs);

test("resolveCacheDir uses the env override, else the home default", () => {
    // Act & Assert
    assert.equal(
        resolveCacheDir({ env: {}, home: "/home/node" }),
        "/home/node/.cache/defined",
    );
    assert.equal(
        resolveCacheDir({
            env: { DEFINED_CACHE_DIR: "/caches/x" },
            home: "/h",
        }),
        "/caches/x",
    );
    // A blank override is ignored (points nowhere rather than the CWD).
    assert.equal(
        resolveCacheDir({ env: { DEFINED_CACHE_DIR: "  " }, home: "/h" }),
        "/h/.cache/defined",
    );
});

test("identityHash is order-independent and value-sensitive", () => {
    // Act
    const a = identityHash({ parts: { tool: "1", config: "x" } });
    const b = identityHash({ parts: { config: "x", tool: "1" } });
    const c = identityHash({ parts: { tool: "2", config: "x" } });

    // Assert
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test("hashFile hashes bytes and returns undefined for a missing file", async () => {
    // Arrange
    const root = await makeTempDir();
    const file = join(root, "a.md");
    writeFileSync(file, "# hi\n");

    // Act & Assert
    assert.equal(
        hashFile({ path: file }),
        createHash("sha256").update("# hi\n").digest("hex"),
    );
    assert.equal(hashFile({ path: join(root, "nope.md") }), undefined);
});

test("a lookup miss is recorded and served on the next run", async () => {
    // Arrange
    const dir = await makeTempDir();
    const cache = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });

    // Act & Assert — the first run misses and records the verdict.
    assert.equal(cache.lookup({ path: "a.md", hash: "h1" }), undefined);
    assert.equal(cache.misses, 1);
    cache.record({ path: "a.md", hash: "h1" }, true);
    cache.flush();

    const reopened = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });

    // Assert — the verdict survives a reopen.
    assert.equal(reopened.lookup({ path: "a.md", hash: "h1" }), true);
    assert.equal(reopened.hits, 1);
    assert.equal(reopened.misses, 0);
});

test("editing content invalidates a file's entry", async () => {
    // Arrange — seed an entry under the original hash.
    const dir = await makeTempDir();
    const cache = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });
    cache.record({ path: "a.md", hash: "h1" }, true);
    cache.flush();

    const reopened = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });

    // Act & Assert — the edited hash no longer matches the entry.
    assert.equal(reopened.lookup({ path: "a.md", hash: "h2" }), undefined);
});

test("a changed identity invalidates every entry", async () => {
    // Arrange — seed an entry under identity v1.
    const dir = await makeTempDir();
    const cache = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "v1",
    });
    cache.record({ path: "a.md", hash: "h1" }, true);
    cache.flush();

    const reopened = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "v2",
    });

    // Act & Assert — identity v2 invalidates the cache.
    assert.equal(reopened.lookup({ path: "a.md", hash: "h1" }), undefined);
});

test("flush drops entries not touched this run (self-pruning)", async () => {
    // Arrange — one run records both entries.
    const dir = await makeTempDir();
    const first = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });
    first.record({ path: "a.md", hash: "h1" }, true);
    first.record({ path: "b.md", hash: "h2" }, false);
    first.flush();

    // Act — the second run touches only a.md, then flushes.
    const second = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });
    assert.equal(second.lookup({ path: "a.md", hash: "h1" }), true);
    second.flush();

    // Assert — b.md was untouched, so it was pruned.
    const third = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });
    assert.equal(third.lookup({ path: "a.md", hash: "h1" }), true);
    // b.md was not touched in the second run, so its entry is gone.
    assert.equal(third.lookup({ path: "b.md", hash: "h2" }), undefined);
});

test("a corrupt manifest is treated as empty and rewritten on flush", async () => {
    // Arrange — a manifest that is not valid JSON.
    const dir = await makeTempDir();
    const manifest = join(dir, "node.json");
    writeFileSync(manifest, "{ not json");

    // Act & Assert — the corrupt manifest reads as an empty cache.
    const cache = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });
    assert.equal(cache.lookup({ path: "a.md", hash: "h1" }), undefined);
    cache.record({ path: "a.md", hash: "h1" }, true);
    cache.flush();

    const reopened = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });

    // Assert — the rewritten manifest serves the new entry.
    assert.equal(reopened.lookup({ path: "a.md", hash: "h1" }), true);
});

test("flush creates the cache dir tree", async () => {
    // Arrange
    const root = await makeTempDir();
    const nested = join(root, "deep", "cache");
    const cache = createFileCache<boolean>({
        dir: nested,
        step: "node",
        identity: "id",
    });
    cache.record({ path: "a.md", hash: "h1" }, true);

    // Act
    cache.flush();

    // Assert — the manifest was written into the created tree.
    assert.equal(
        readFileSync(join(nested, "node.json"), "utf8").length > 0,
        true,
    );
});

test("flush never throws when it cannot write", async () => {
    // Arrange — a file where a directory is needed, so mkdir fails.
    const root = await makeTempDir();
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "x");
    const cache = createFileCache<boolean>({
        dir: join(blocked, "sub"),
        step: "node",
        identity: "id",
    });
    cache.record({ path: "a.md", hash: "h1" }, true);

    // Act & Assert — the mkdir failure is swallowed: a cache miss at worst.
    assert.doesNotThrow(() => cache.flush());
});

test("partitionByHash reuses cached verdicts and lists only the misses", async () => {
    // Arrange — seed a.md as a hit.
    const root = await makeTempDir();
    writeFileSync(join(root, "a.md"), "# a\n");
    writeFileSync(join(root, "b.md"), "# b\n");
    const seeded = createFileCache<boolean>({
        dir: root,
        step: "node",
        identity: "id",
    });
    const aHash = hashFile({ path: join(root, "a.md") })!;
    seeded.record({ path: "a.md", hash: aHash }, true);
    seeded.flush();
    const cache = createFileCache<boolean>({
        dir: root,
        step: "node",
        identity: "id",
    });

    // Act
    const { cached, missing, hashes } = partitionByHash<boolean>({
        paths: ["a.md", "b.md", "gone.md"],
        workingRoot: root,
        cache,
    });

    // Assert
    assert.deepEqual([...cached], [["a.md", true]]);
    assert.deepEqual(missing, ["b.md", "gone.md"]);
    assert.deepEqual([...hashes.keys()], ["a.md", "b.md"]);
});

test("reportCacheMetric emits on the notify sink", () => {
    // Arrange
    const lines: string[] = [];

    // Act
    reportCacheMetric({
        notify: (line) => lines.push(line),
        step: "node",
        cache: { hits: 3, misses: 1 },
    });

    // Assert
    assert.deepEqual(lines, ["defined: cache node hit=3 miss=1"]);
});

test("reportCacheMetric is silent without a notify sink", () => {
    // Act & Assert — no sink means nowhere to write, so it stays quiet.
    assert.doesNotThrow(() =>
        reportCacheMetric({ step: "node", cache: { hits: 0, misses: 0 } }),
    );
});

test("sha256Hex matches node's crypto for strings and buffers", () => {
    // Act & Assert — strings and buffers hash identically.
    assert.equal(
        sha256Hex({ data: "abc" }),
        createHash("sha256").update("abc").digest("hex"),
    );
    assert.equal(
        sha256Hex({ data: Buffer.from("abc") }),
        createHash("sha256").update("abc").digest("hex"),
    );
});
