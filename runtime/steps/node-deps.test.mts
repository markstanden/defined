// Tests for steps/node-deps.mts: consumer dependency restore shared by the node
// family. Runner injected; no host binaries needed.
// Run: node --test steps/node-deps.test.mts

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { runNodeDepsStep } from "./node-deps.mts";
import { runNodeStep } from "./node.mts";
import { cleanupScratch } from "../lib/scratch.mts";
import {
    cleanupTempDirs,
    makeTempDir,
    recordingRunner,
} from "../test-helpers.mts";

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

async function writeConfig(
    root: string,
    config: Record<string, unknown>,
): Promise<void> {
    await writeFile(`${root}/.defined.json`, `${JSON.stringify(config)}\n`);
}

test("runNodeDepsStep skips when nothing is declared or implied", async () => {
    const root = await makeTempDir("quality-node-deps-");
    await writeTree(root, { "package.json": "{}\n" });
    const { runner, calls } = recordingRunner();
    const result = await runNodeDepsStep({
        ctx: { mode: "fix", repoRoot: root },
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "skip");
    assert.match(result.notice ?? "", /no dependencies to restore/u);
    assert.equal(calls.length, 0);
});

test("runNodeDepsStep restores the root package for a consumer Prettier config without a node section", async () => {
    const root = await makeTempDir("quality-node-deps-");
    await writeTree(root, {
        "package.json": '{ "name": "consumer" }\n',
        "package-lock.json": "{}\n",
        "prettier.config.mjs":
            'export default { plugins: ["prettier-plugin-x"] };\n',
    });
    const { runner, calls } = recordingRunner();
    const result = await runNodeDepsStep({
        ctx: { mode: "fix", repoRoot: root },
        trackedFiles: [
            "package.json",
            "package-lock.json",
            "prettier.config.mjs",
        ],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => c.args[1]),
        ["npm ci"],
    );
    assert.equal(calls[0]!.cwd, root);
});

test("runNodeDepsStep restores a declared package with local binaries first", async () => {
    const root = await makeTempDir("quality-node-deps-");
    await writeTree(root, { "lib/package.json": "{}\n" });
    await writeConfig(root, {
        node: {
            checks: [{ name: "lint", command: "eslint ." }],
        },
    });
    const { runner, calls } = recordingRunner();
    const result = await runNodeDepsStep({
        ctx: { mode: "fix", repoRoot: root },
        trackedFiles: ["lib/package.json"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => c.args[1]),
        ["npm install"],
    );
    assert.equal(calls[0]!.cwd, `${root}/lib`);
    assert.ok(
        calls[0]!.env!.PATH!.startsWith(`${root}/lib/node_modules/.bin:`),
    );
    assert.ok(calls[0]!.env!.PATH!.includes(`${root}/node_modules/.bin`));
});

test("runNodeDepsStep honours a declared install command", async () => {
    const root = await makeTempDir("quality-node-deps-");
    await writeTree(root, { "package.json": "{}\n" });
    await writeConfig(root, {
        node: {
            dir: ".",
            install: "npm ci --ignore-scripts",
            checks: [{ name: "test", command: "vitest run" }],
        },
    });
    const { runner, calls } = recordingRunner();
    const result = await runNodeDepsStep({
        ctx: { mode: "fix", repoRoot: root },
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.equal(calls[0]!.args[1], "npm ci --ignore-scripts");
});

test("install:false restores nothing and skips", async () => {
    const root = await makeTempDir("quality-node-deps-");
    await writeTree(root, { "package.json": "{}\n" });
    await writeConfig(root, {
        node: {
            install: false,
            checks: [{ name: "typecheck", command: "tsc --noEmit" }],
        },
    });
    const { runner, calls } = recordingRunner();
    const result = await runNodeDepsStep({
        ctx: { mode: "fix", repoRoot: root },
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("a failing restore fails the step naming the package", async () => {
    const root = await makeTempDir("quality-node-deps-");
    await writeTree(root, { "package.json": "{}\n" });
    await writeConfig(root, {
        node: { checks: [{ name: "test", command: "vitest run" }] },
    });
    const { runner } = recordingRunner({
        "npm install": { status: 1, stdout: "registry unreachable" },
    });
    const result = await runNodeDepsStep({
        ctx: { mode: "fix", repoRoot: root },
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /\.: install failed/u);
    assert.match(result.notice ?? "", /registry unreachable/u);
});

test("a declared package dir without package.json fails loudly", async () => {
    const root = await makeTempDir("quality-node-deps-");
    await writeTree(root, { "package.json": "{}\n" });
    await writeConfig(root, {
        node: {
            dir: "nope",
            checks: [{ name: "test", command: "vitest run" }],
        },
    });
    const { runner, calls } = recordingRunner();
    const result = await runNodeDepsStep({
        ctx: { mode: "fix", repoRoot: root },
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /no package\.json at nope/u);
    assert.equal(calls.length, 0);
});

test("no-fix restores in a scratch copy, never the repo mount", async () => {
    const root = await makeTempDir("quality-node-deps-");
    await writeTree(root, {
        "package.json": "{}\n",
        "package-lock.json": "{}\n",
    });
    await writeConfig(root, {
        node: { checks: [{ name: "test", command: "vitest run" }] },
    });
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        const result = await runNodeDepsStep({
            ctx: { mode: "no-fix", repoRoot: root, scratch },
            trackedFiles: ["package.json", "package-lock.json"],
            runner,
        });
        assert.equal(result.status, "pass");
        assert.ok(scratch.dir !== null);
        assert.equal(calls[0]!.cwd, scratch.dir);
        assert.notEqual(calls[0]!.cwd, root);
    } finally {
        cleanupScratch(scratch);
    }
});

test("no-fix restore and formatting share one scratch working root, so a config plugin can resolve", async () => {
    // Regression for issue #40: a consumer config declaring a plugin, a fresh
    // checkout with no node_modules. Restore and prettier must use the same
    // working root, or prettier resolves plugins from the untouched checkout.
    const root = await makeTempDir("quality-node-deps-");
    await writeTree(root, {
        "package.json": '{ "devDependencies": { "prettier-plugin-x": "*" } }\n',
        "package-lock.json": "{}\n",
        "prettier.config.mjs":
            'export default { plugins: ["prettier-plugin-x"] };\n',
        "index.ts": "const a = 1;\n",
    });
    const trackedFiles = [
        "package.json",
        "package-lock.json",
        "prettier.config.mjs",
        "index.ts",
    ];
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        const deps = await runNodeDepsStep({
            ctx: { mode: "no-fix", repoRoot: root, scratch },
            trackedFiles,
            runner,
        });
        const node = await runNodeStep({
            ctx: { mode: "no-fix", repoRoot: root, scratch },
            trackedFiles,
            runner,
        });

        assert.equal(deps.status, "pass");
        assert.equal(node.status, "pass");
        assert.ok(scratch.dir !== null);

        const install = calls.find((c) => c.args[1] === "npm ci");
        const prettier = calls.find((c) => c.cmd === "prettier");
        assert.ok(install, "dependencies must be restored");
        assert.ok(prettier, "prettier must run");

        // One working root: the scratch copy, not the read-only checkout.
        assert.equal(install.cwd, scratch.dir);
        assert.equal(prettier.cwd, scratch.dir);
        assert.notEqual(prettier.cwd, root);

        // The config is the scratch copy, so its plugins resolve from the
        // node_modules the restore created beside it.
        const configIndex = prettier.args.indexOf("--config");
        assert.equal(
            prettier.args[configIndex + 1],
            join(scratch.dir, "prettier.config.mjs"),
        );
    } finally {
        cleanupScratch(scratch);
    }
});
