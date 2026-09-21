// Tests for lib/node-packages.mts: package resolution and dependency restore
// shared by the node-deps and node-checks steps. Runner and existsSync
// injected; no host binaries needed.
// Run: node --test lib/node-packages.test.mts

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
    defaultInstall,
    filterPackageJsons,
    packagesToRestore,
    resolvePackageDir,
    restoreNodePackages,
} from "./node-packages.mts";
import { cleanupTempDirs, fakeRunner, makeTempDir } from "../test-helpers.mts";

afterEach(cleanupTempDirs);

async function writeTree(
    root: string,
    files: Record<string, string>,
): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, rel)), { recursive: true });
        await writeFile(join(root, rel), content);
    }
}

test("filterPackageJsons finds package.json files at any depth", () => {
    assert.deepEqual(
        filterPackageJsons({
            files: ["package.json", "lib/package.json", "a.sh"],
        }),
        ["package.json", "lib/package.json"],
    );
});

test("resolvePackageDir uses the sole tracked package.json without a dir", () => {
    assert.deepEqual(
        resolvePackageDir({
            files: ["lib/package.json", "a.sh"],
            dir: undefined,
        }),
        { dir: "lib" },
    );
});

test("resolvePackageDir rejects several packages without a dir", () => {
    const resolved = resolvePackageDir({
        files: ["package.json", "lib/package.json"],
        dir: undefined,
    });
    assert.ok("error" in resolved);
    assert.match(resolved.error, /multiple package\.json/u);
});

test("resolvePackageDir honours an explicit root dir", () => {
    assert.deepEqual(
        resolvePackageDir({ files: ["lib/package.json"], dir: "" }),
        { dir: "" },
    );
});

test("defaultInstall picks the lockfile's package manager, npm as fallback", () => {
    const existsIn = (present: string[]) => (path: string) =>
        present.some((p) => path.endsWith(p));
    assert.equal(
        defaultInstall({
            packageDir: "/pkg",
            exists: existsIn(["package-lock.json"]),
        }),
        "npm ci",
    );
    assert.equal(
        defaultInstall({ packageDir: "/pkg", exists: existsIn(["yarn.lock"]) }),
        "yarn install --frozen-lockfile",
    );
    assert.equal(
        defaultInstall({
            packageDir: "/pkg",
            exists: existsIn(["pnpm-lock.yaml"]),
        }),
        "pnpm install --frozen-lockfile",
    );
    assert.equal(
        defaultInstall({ packageDir: "/pkg", exists: () => false }),
        "npm install",
    );
});

test("packagesToRestore leaves the declared list alone with no consumer config", () => {
    const declared = [{ dir: "frontend" }];
    assert.deepEqual(
        packagesToRestore({
            declared,
            trackedFiles: ["frontend/package.json", "package.json"],
        }),
        declared,
    );
});

test("packagesToRestore adds the root package when a consumer Prettier config is tracked", () => {
    assert.deepEqual(
        packagesToRestore({
            declared: [],
            trackedFiles: ["package.json", "prettier.config.mjs"],
        }),
        [{ dir: "" }],
    );
});

test("packagesToRestore never duplicates a declared root and honours its opt-out", () => {
    // A declared root (even install:false) owns the root: no auto-added copy.
    const declared = [{ dir: "", install: false }];
    assert.deepEqual(
        packagesToRestore({
            declared,
            trackedFiles: ["package.json", "prettier.config.mjs"],
        }),
        declared,
    );
});

test("restoreNodePackages restores each distinct directory once", async () => {
    const root = await makeTempDir("quality-node-packages-");
    await writeTree(root, { "package.json": "{}\n" });
    const { runner, calls } = fakeRunner({}, true);
    const result = restoreNodePackages({
        workingRoot: root,
        trackedFiles: ["package.json"],
        packages: [{ dir: "" }, { dir: "" }],
        runner,
    });
    assert.deepEqual(result, { failures: [], restored: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.at(-1), root);
});

test("restoreNodePackages reports a missing manifest and installs nothing", async () => {
    const root = await makeTempDir("quality-node-packages-");
    const { runner, calls } = fakeRunner({}, true);
    const result = restoreNodePackages({
        workingRoot: root,
        trackedFiles: ["package.json"],
        packages: [{ dir: "" }],
        runner,
    });
    assert.deepEqual(result.failures, ["no package.json at ."]);
    assert.equal(result.restored, 0);
    assert.equal(calls.length, 0);
});
