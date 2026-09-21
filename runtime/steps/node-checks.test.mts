// Tests for steps/node-checks.mts: consumer ESLint/tsc/test via the consumer's
// own toolchain. Dependency restore is covered by steps/node-deps.test.mts and
// lib/node-packages.test.mts. Runner and existsSync injected; no host binaries.
// Run: node --test steps/node-checks.test.mts

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { runNodeChecksStep } from "./node-checks.mts";
import { cleanupScratch } from "../lib/scratch.mts";
import {
    baseCtx,
    cleanupTempDirs,
    makeTempDir,
    recordingRunner,
} from "../test-helpers.mts";

afterEach(cleanupTempDirs);

async function writeConfig(
    root: string,
    config: Record<string, unknown>,
): Promise<void> {
    await writeFile(`${root}/.defined.json`, `${JSON.stringify(config)}\n`);
}

test("runNodeChecksStep skips when no node checks are declared", async () => {
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, { coverage: { node: { command: "npm t" } } });
    const { runner, calls } = recordingRunner();
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root },
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "skip");
    assert.match(result.notice ?? "", /no checks declared/u);
    assert.equal(calls.length, 0);
});

test("runNodeChecksStep runs checks with consumer binaries first", async () => {
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            checks: [
                { name: "lint", command: "eslint ." },
                { name: "typecheck", command: "tsc --noEmit" },
            ],
        },
    });
    const { runner, calls } = recordingRunner();
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["lib/package.json"],
        runner,
        existsSyncFn: () => true,
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => c.args[1]),
        ["eslint .", "tsc --noEmit"],
    );
    // Commands run in the nested package dir with its local bin dir on PATH.
    const lint = calls[0]!;
    assert.equal(lint.cwd, `${root}/lib`);
    assert.ok(lint.env!.PATH!.startsWith(`${root}/lib/node_modules/.bin:`));
    assert.ok(lint.env!.PATH!.includes(`${root}/node_modules/.bin`));
});

test("a failing check fails the step naming the package and check", async () => {
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            checks: [{ name: "lint", command: "eslint ." }],
        },
    });
    const { runner } = recordingRunner({
        "eslint .": { status: 1, stdout: "3 problems" },
    });
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
        existsSyncFn: () => true,
    });
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /lint failed/u);
    assert.match(result.notice ?? "", /3 problems/u);
});

test("fix mode runs the autofix before the check; no-fix does not", async () => {
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            checks: [
                { name: "lint", command: "eslint .", fix: "eslint --fix ." },
            ],
        },
    });
    await writeFile(`${root}/package.json`, "{}\n");

    const fixing = recordingRunner();
    await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner: fixing.runner,
        existsSyncFn: () => true,
    });
    assert.deepEqual(
        fixing.calls.map((c) => c.args[1]),
        ["eslint --fix .", "eslint ."],
    );

    const checking = recordingRunner();
    await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "no-fix" },
        trackedFiles: ["package.json"],
        runner: checking.runner,
        existsSyncFn: () => true,
    });
    assert.deepEqual(
        checking.calls.map((c) => c.args[1]),
        ["eslint ."],
    );
});

test("a declared package dir without package.json fails loudly", async () => {
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            dir: "nope",
            checks: [{ name: "test", command: "vitest run" }],
        },
    });
    const { runner, calls } = recordingRunner();
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
        existsSyncFn: () => false,
    });
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /no package\.json at nope/u);
    assert.equal(calls.length, 0);
});

test("a monorepo package list runs each package in its own directory", async () => {
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            packages: [
                {
                    dir: "packages/a",
                    install: false,
                    checks: [{ name: "a", command: "eslint ." }],
                },
                {
                    dir: "packages/b",
                    install: false,
                    checks: [{ name: "b", command: "tsc --noEmit" }],
                },
            ],
        },
    });
    const { runner, calls } = recordingRunner();
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["packages/a/package.json", "packages/b/package.json"],
        runner,
        existsSyncFn: () => true,
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => [c.args[1], c.cwd]),
        [
            ["eslint .", `${root}/packages/a`],
            ["tsc --noEmit", `${root}/packages/b`],
        ],
    );
});

test("no-fix runs checks in a scratch copy, never the repo mount", async () => {
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            install: false,
            checks: [{ name: "test", command: "vitest run" }],
        },
    });
    await writeFile(`${root}/package.json`, "{}\n");
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        const result = await runNodeChecksStep({
            ctx: { ...baseCtx, repoRoot: root, mode: "no-fix", scratch },
            trackedFiles: ["package.json"],
            runner,
            existsSyncFn: () => true,
        });
        assert.equal(result.status, "pass");
        assert.ok(scratch.dir !== null);
        assert.equal(calls[0]!.cwd, scratch.dir);
        assert.notEqual(calls[0]!.cwd, root);
    } finally {
        cleanupScratch(scratch);
    }
});
