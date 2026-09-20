// Tests for steps/node-checks.mts: consumer ESLint/tsc/test via the consumer's
// own toolchain. Runner and existsSync injected; no host binaries needed.
// Run: node --test steps/node-checks.test.mts

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import {
    defaultInstall,
    filterPackageJsons,
    resolvePackageDir,
    runNodeChecksStep,
} from "./node-checks.mts";
import { cleanupScratch } from "../lib/scratch.mts";
import { baseCtx, cleanupTempDirs, makeTempDir } from "../test-helpers.mts";
import type { CommandResult } from "../../lib/proc.mts";

afterEach(cleanupTempDirs);

type RunInput = {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
};

/** Records full runner input (including cwd/env) and maps shell commands to outcomes. */
function recordingRunner(
    outcomes: Record<string, { status: number; out?: string }> = {},
): {
    runner: typeof import("../../lib/proc.mts").run;
    calls: RunInput[];
} {
    const calls: RunInput[] = [];
    const runner = ((input: RunInput) => {
        calls.push(input);
        const command = input.args[1] ?? input.cmd;
        const outcome = outcomes[command] ?? { status: 0 };
        return {
            status: outcome.status,
            stdout: outcome.out ?? "",
            stderr: "",
        } satisfies CommandResult;
    }) as typeof import("../../lib/proc.mts").run;
    return { runner, calls };
}

async function writeConfig(
    root: string,
    config: Record<string, unknown>,
): Promise<void> {
    await writeFile(`${root}/.defined.json`, `${JSON.stringify(config)}\n`);
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

test("runNodeChecksStep restores deps then runs checks, consumer binaries first", async () => {
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
        ["npm ci", "eslint .", "tsc --noEmit"],
    );
    // Commands run in the nested package dir with its local bin dir on PATH.
    const lint = calls[1]!;
    assert.equal(lint.cwd, `${root}/lib`);
    assert.ok(lint.env!.PATH!.startsWith(`${root}/lib/node_modules/.bin:`));
    assert.ok(lint.env!.PATH!.includes(`${root}/node_modules/.bin`));
});

test("runNodeChecksStep honours a declared install command", async () => {
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            dir: ".",
            install: "npm ci --ignore-scripts",
            checks: [{ name: "test", command: "vitest run" }],
        },
    });
    const { runner, calls } = recordingRunner();
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
        existsSyncFn: () => true,
    });
    assert.equal(result.status, "pass");
    assert.equal(calls[0]!.args[1], "npm ci --ignore-scripts");
});

test("install:false skips dependency restore", async () => {
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            install: false,
            checks: [{ name: "typecheck", command: "tsc --noEmit" }],
        },
    });
    const { runner, calls } = recordingRunner();
    const result = await runNodeChecksStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
        existsSyncFn: () => true,
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => c.args[1]),
        ["tsc --noEmit"],
    );
});

test("a failing check fails the step naming the package and check", async () => {
    const root = await makeTempDir("quality-node-checks-");
    await writeConfig(root, {
        node: {
            checks: [{ name: "lint", command: "eslint ." }],
        },
    });
    const { runner } = recordingRunner({
        "eslint .": { status: 1, out: "3 problems" },
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
        ["npm ci", "eslint --fix .", "eslint ."],
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
        ["npm ci", "eslint ."],
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
