// Tests for lib/cache.mts: the content-addressed per-file cache (#68).
// Run: node --test lib/cache.test.mts

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
    const a = identityHash({ parts: { tool: "1", config: "x" } });
    const b = identityHash({ parts: { config: "x", tool: "1" } });
    const c = identityHash({ parts: { tool: "2", config: "x" } });
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test("hashFile hashes bytes and returns undefined for a missing file", async () => {
    const root = await makeTempDir();
    const file = join(root, "a.md");
    writeFileSync(file, "# hi\n");
    assert.equal(
        hashFile({ path: file }),
        createHash("sha256").update("# hi\n").digest("hex"),
    );
    assert.equal(hashFile({ path: join(root, "nope.md") }), undefined);
});

test("a lookup miss is recorded and served on the next run", async () => {
    const dir = await makeTempDir();
    const cache = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });
    assert.equal(cache.lookup({ path: "a.md", hash: "h1" }), undefined);
    assert.equal(cache.misses, 1);
    cache.record({ path: "a.md", hash: "h1" }, true);
    cache.flush();

    const reopened = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });
    assert.equal(reopened.lookup({ path: "a.md", hash: "h1" }), true);
    assert.equal(reopened.hits, 1);
    assert.equal(reopened.misses, 0);
});

test("editing content invalidates a file's entry", async () => {
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
    assert.equal(reopened.lookup({ path: "a.md", hash: "h2" }), undefined);
});

test("a changed identity invalidates every entry", async () => {
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
    assert.equal(reopened.lookup({ path: "a.md", hash: "h1" }), undefined);
});

test("flush drops entries not touched this run (self-pruning)", async () => {
    const dir = await makeTempDir();
    const first = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });
    first.record({ path: "a.md", hash: "h1" }, true);
    first.record({ path: "b.md", hash: "h2" }, false);
    first.flush();

    const second = createFileCache<boolean>({
        dir,
        step: "node",
        identity: "id",
    });
    assert.equal(second.lookup({ path: "a.md", hash: "h1" }), true);
    second.flush();

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
    const dir = await makeTempDir();
    const manifest = join(dir, "node.json");
    writeFileSync(manifest, "{ not json");

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
    assert.equal(reopened.lookup({ path: "a.md", hash: "h1" }), true);
});

test("flush creates the cache dir tree and never throws when it cannot write", async () => {
    const root = await makeTempDir();
    const nested = join(root, "deep", "cache");
    const cache = createFileCache<boolean>({
        dir: nested,
        step: "node",
        identity: "id",
    });
    cache.record({ path: "a.md", hash: "h1" }, true);
    cache.flush();
    assert.equal(
        readFileSync(join(nested, "node.json"), "utf8").length > 0,
        true,
    );

    // A file where a directory is needed: mkdir fails, flush must swallow it.
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "x");
    const broken = createFileCache<boolean>({
        dir: join(blocked, "sub"),
        step: "node",
        identity: "id",
    });
    broken.record({ path: "a.md", hash: "h1" }, true);
    assert.doesNotThrow(() => broken.flush());
});

test("partitionByHash reuses cached verdicts and lists only the misses", async () => {
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

    const { cached, missing, hashes } = partitionByHash<boolean>({
        paths: ["a.md", "b.md", "gone.md"],
        workingRoot: root,
        cache,
    });
    assert.deepEqual([...cached], [["a.md", true]]);
    assert.deepEqual(missing, ["b.md", "gone.md"]);
    assert.deepEqual([...hashes.keys()], ["a.md", "b.md"]);
});

test("reportCacheMetric emits on the notify sink and is silent without one", () => {
    const lines: string[] = [];
    reportCacheMetric({
        notify: (line) => lines.push(line),
        step: "node",
        cache: { hits: 3, misses: 1 },
    });
    assert.deepEqual(lines, ["defined: cache node hit=3 miss=1"]);
    assert.doesNotThrow(() =>
        reportCacheMetric({ step: "node", cache: { hits: 0, misses: 0 } }),
    );
});

test("sha256Hex matches node's crypto for strings and buffers", () => {
    assert.equal(
        sha256Hex({ data: "abc" }),
        createHash("sha256").update("abc").digest("hex"),
    );
    assert.equal(
        sha256Hex({ data: Buffer.from("abc") }),
        createHash("sha256").update("abc").digest("hex"),
    );
});
