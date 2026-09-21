// Tests for steps/node.mts: repo-wide formatting via prettier.
// Runner injected, so no host binaries are needed here.
// Run: node --test steps/node.test.mts

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
    filterMarkdownFiles,
    filterPrettierFiles,
    prettierConfigArgs,
    prettierIgnoreArgs,
    runNodeStep,
} from "./node.mts";
import { filterPackageJsons } from "../lib/node-packages.mts";
import { cleanupScratch } from "../lib/scratch.mts";
import {
    baseCtx,
    cleanupTempDirs,
    makeTempDir,
    recordingRunner,
} from "../test-helpers.mts";
import type { CommandResult } from "../../lib/proc.mts";

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
            files: [
                "package.json",
                "lib/package.json",
                "a.sh",
                "packages/x/package.json",
            ],
        }),
        ["package.json", "lib/package.json", "packages/x/package.json"],
    );
});

test("filterMarkdownFiles finds .md files at any depth", () => {
    assert.deepEqual(
        filterMarkdownFiles({
            files: ["README.md", "docs/guide.md", "a.sh", "b.yml"],
        }),
        ["README.md", "docs/guide.md"],
    );
});

test("filterPrettierFiles keeps parseable extensions and drops the rest", () => {
    // The filter is extension-based: gitignored build dirs never reach the
    // gate's tracked list upstream, so parseable committed content (even a
    // force-tracked bin/obj JSON) is in scope.
    assert.deepEqual(
        filterPrettierFiles({
            files: [
                "package.json",
                "src/app.ts",
                "README.md",
                "docs/guide.md",
                "scripts/setup.sh",
                "config/settings.toml",
                ".editorconfig",
                "bin/Debug/app.deps.json",
                "obj/project.assets.json",
                "dist/bundle.js",
                "coverage/lcov.info",
            ],
        }),
        [
            "package.json",
            "src/app.ts",
            "README.md",
            "docs/guide.md",
            "bin/Debug/app.deps.json",
            "obj/project.assets.json",
            "dist/bundle.js",
        ],
    );
});

test("runNodeStep skips cleanly when neither package.json nor .md is tracked", async () => {
    const { runner, calls } = recordingRunner();
    const result = await runNodeStep({
        ctx: baseCtx,
        trackedFiles: ["a.sh", "b.yml"],
        runner,
    });
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("runNodeStep runs prettier for a docs-only repo (no package.json)", async () => {
    const root = await makeTempDir("quality-node-");
    await writeTree(root, {
        "README.md": "# title\n",
        "docs/guide.md": "# guide\n",
    });
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        const result = await runNodeStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["README.md", "docs/guide.md"],
            runner,
        });
        assert.equal(result.status, "pass");
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.cmd, "prettier");
        assert.equal(calls[0]!.args[0], "--check");
    } finally {
        cleanupScratch(scratch);
    }
});

test("check mode runs prettier --check in the scratch working root with the git-scoped file list", async () => {
    const root = await makeTempDir("quality-node-");
    await writeTree(root, {
        "package.json": "{}\n",
        "README.md": "# title\n",
        "scripts/setup.sh": "#!/usr/bin/env bash\n",
    });
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        const result = await runNodeStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["package.json", "README.md", "scripts/setup.sh"],
            runner,
        });
        assert.equal(result.status, "pass");
        assert.equal(calls.length, 1);
        const call = calls[0]!;
        assert.equal(call.cmd, "prettier");
        assert.equal(call.args[0], "--check");
        assert.equal(call.args[1], "--config");
        assert.match(call.args[2]!, /runtime\/config\/prettier\.config\.mjs$/u);
        assert.equal(call.args[3], "--ignore-path");
        assert.match(call.args[4]!, /runtime\/config\/prettierignore$/u);
        // prettier gets exactly the parseable tracked files, never "." — build
        // dirs are gitignored so already absent, and .sh is not prettier's.
        assert.deepEqual(call.args.slice(5), ["package.json", "README.md"]);
        // No-fix formats the scratch copy, not the read-only checkout.
        assert.ok(scratch.dir !== null);
        assert.equal(call.cwd, scratch.dir);
        assert.notEqual(call.cwd, root);
    } finally {
        cleanupScratch(scratch);
    }
});

test("fix mode writes then re-checks before reporting success", async () => {
    const root = await makeTempDir("quality-node-");
    await writeTree(root, { "package.json": "{}\n" });
    const { runner, calls } = recordingRunner();
    const result = await runNodeStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => (c.cmd !== "prettier" ? c.cmd : c.args[0])),
        ["--write", "--check"],
    );
    // Fix mode works in the repo itself.
    assert.equal(calls[0]!.cwd, root);
});

test("a fix that leaves diffs can never read as success", async () => {
    const root = await makeTempDir("quality-node-");
    await writeTree(root, { "package.json": "{}\n" });
    let calls = 0;
    const runner = (({ cmd, args }: { cmd: string; args: string[] }) => {
        calls += 1;
        const status = calls === 1 ? 0 : 1;
        return { status, stdout: "", stderr: "" } satisfies CommandResult;
    }) as typeof import("../../lib/proc.mts").run;
    const result = await runNodeStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "fail");
});

test("check mode failure names prettier and the file count", async () => {
    const root = await makeTempDir("quality-node-");
    await writeTree(root, { "package.json": "{}\n" });
    const scratch = { dir: null };
    const { runner } = recordingRunner({
        prettier: { status: 1, stdout: "a.md\nb.md\nc.md\n" },
    });
    try {
        const result = await runNodeStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["package.json"],
            runner,
        });
        assert.equal(result.status, "fail");
        assert.ok((result.notice ?? "").includes("prettier"));
    } finally {
        cleanupScratch(scratch);
    }
});

test("prettierIgnoreArgs passes the travelling ignore and adds the host .prettierignore when present", async () => {
    const root = await makeTempDir("quality-node-ignore-");
    // No host file: single travelling ignore.
    const bare = await prettierIgnoreArgs({ repoRoot: root });
    assert.equal(bare.filter((a) => a === "--ignore-path").length, 1);
    assert.match(bare[1]!, /runtime\/config\/prettierignore$/u);

    // Host file present: second --ignore-path points at the repo root.
    await writeFile(join(root, ".prettierignore"), "dotfiles/nvim/\n");
    const withHost = await prettierIgnoreArgs({ repoRoot: root });
    assert.equal(withHost.filter((a) => a === "--ignore-path").length, 2);
    assert.equal(withHost[3], join(root, ".prettierignore"));
});

test("prettierConfigArgs falls back to the travelling config with no consumer file", async () => {
    const root = await makeTempDir("quality-node-config-bare-");
    const args = await prettierConfigArgs({ repoRoot: root });
    assert.equal(args[0], "--config");
    assert.match(args[1]!, /runtime\/config\/prettier\.config\.mjs$/u);
});

test("a consumer-owned prettier config replaces the travelling default", async () => {
    const root = await makeTempDir("quality-node-config-");
    await writeTree(root, {
        "package.json": "{}\n",
        "prettier.config.mjs": "export default {};\n",
    });
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        const result = await runNodeStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["package.json", "prettier.config.mjs"],
            runner,
        });
        assert.equal(result.status, "pass");
        const call = calls[0]!;
        assert.equal(call.args[1], "--config");
        // The config is the scratch copy, beside the restored dependencies.
        assert.equal(call.args[2], join(scratch.dir!, "prettier.config.mjs"));
    } finally {
        cleanupScratch(scratch);
    }
});
