// Tests for steps/node-checks.mts: consumer ESLint/tsc/test via the consumer's
// own toolchain. Dependency restore is covered by steps/node-deps.test.mts and
// lib/node-packages.test.mts. Runner and existsSync injected; no host binaries.
// Run: node --test runtime/steps/node-checks.test.mts

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
    // Arrange
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, { coverage: { node: { command: "npm t" } } });
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root },
        trackedFiles: ["package.json"],
        runner,
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.match(result.notice ?? "", /no checks declared/u);
    assert.equal(calls.length, 0);
});

test("runNodeChecksStep runs checks with consumer binaries first", async () => {
    // Arrange
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

    // Act
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, scratch: { dir: root } },
        trackedFiles: ["lib/package.json"],
        runner,
        existsSyncFn: () => true,
    });

    // Assert
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

test("runNodeChecksStep skips a check satisfied by the coverage command (#66)", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            checks: [
                { name: "lint", command: "eslint ." },
                { name: "test", command: "vitest run" },
            ],
        },
        coverage: {
            node: {
                command: "vitest run --coverage",
                satisfies: { package: "", check: "test" },
            },
        },
    });
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "no-fix" },
        trackedFiles: ["package.json"],
        runner,
        existsSyncFn: () => true,
    });

    // Assert
    assert.equal(result.status, "pass");
    // The named check never runs here; the coverage command runs it once.
    assert.deepEqual(
        calls.map((c) => c.args[1]),
        ["eslint ."],
    );
    assert.match(result.notice ?? "", /1 check\(s\) passed/u);
});

test("runNodeChecksStep only skips a satisfied check in the matching package (#66)", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            packages: [
                {
                    dir: "a",
                    checks: [{ name: "test", command: "vitest run" }],
                },
                {
                    dir: "b",
                    checks: [{ name: "test", command: "vitest run" }],
                },
            ],
        },
        coverage: {
            node: {
                command: "vitest run --coverage",
                satisfies: { package: "a", check: "test" },
            },
        },
    });
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "no-fix" },
        trackedFiles: ["a/package.json", "b/package.json"],
        runner,
        existsSyncFn: () => true,
    });

    // Assert
    assert.equal(result.status, "pass");
    // Only package "b"'s test runs; package "a"'s is satisfied by coverage.
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.cwd!, /\/b$/u);
});

test("a failing check fails the step naming the package and check", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            checks: [{ name: "lint", command: "eslint ." }],
        },
    });
    const { runner } = recordingRunner({
        "eslint .": { status: 1, stdout: "3 problems" },
    });

    // Act
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, scratch: { dir: root } },
        trackedFiles: ["package.json"],
        runner,
        existsSyncFn: () => true,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /lint failed/u);
    assert.match(result.notice ?? "", /3 problems/u);
});

test("fix mode runs the autofix only, never the check (#65)", async () => {
    // Arrange
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

    // Act
    await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner: fixing.runner,
        existsSyncFn: () => true,
    });

    // Assert — repair mutation only: the autofix, never the check.
    assert.deepEqual(
        fixing.calls.map((c) => c.args[1]),
        ["eslint --fix ."],
    );
});

test("no-fix mode runs the check only, never the autofix (#65)", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            checks: [
                { name: "lint", command: "eslint .", fix: "eslint --fix ." },
            ],
        },
    });
    await writeFile(`${root}/package.json`, "{}\n");
    const checking = recordingRunner();

    // Act
    await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "no-fix" },
        trackedFiles: ["package.json"],
        runner: checking.runner,
        existsSyncFn: () => true,
    });

    // Assert
    assert.deepEqual(
        checking.calls.map((c) => c.args[1]),
        ["eslint ."],
    );
});

test("a declared package dir without package.json fails loudly", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            dir: "nope",
            checks: [{ name: "test", command: "vitest run" }],
        },
    });
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
        existsSyncFn: () => false,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /no package\.json at nope/u);
    assert.equal(calls.length, 0);
});

test("a monorepo package list runs each package in its own directory", async () => {
    // Arrange
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

    // Act
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, scratch: { dir: root } },
        trackedFiles: ["packages/a/package.json", "packages/b/package.json"],
        runner,
        existsSyncFn: () => true,
    });

    // Assert
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
    // Arrange
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
        // Act
        const result = await runNodeChecksStep({
            ctx: { ...baseCtx, repoRoot: root, mode: "no-fix", scratch },
            trackedFiles: ["package.json"],
            runner,
            existsSyncFn: () => true,
        });

        // Assert
        assert.equal(result.status, "pass");
        assert.ok(scratch.dir !== null);
        assert.equal(calls[0]!.cwd, scratch.dir);
        assert.notEqual(calls[0]!.cwd, root);
    } finally {
        cleanupScratch(scratch);
    }
});
