// Tests for steps/node.mts: repo-wide formatting via prettier.
// Runner injected, so no host binaries are needed here.
// Run: node --test steps/node.test.mts

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
    filterMarkdownFiles,
    filterPackageJsons,
    filterPrettierFiles,
    prettierIgnoreArgs,
    runNodeStep,
} from "./node.mts";
import { baseCtx, fakeRunner } from "../test-helpers.mts";

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
    const { runner, calls } = fakeRunner({});
    const result = await runNodeStep({
        ctx: baseCtx,
        trackedFiles: ["a.sh", "b.yml"],
        runner,
    });
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("runNodeStep runs prettier for a docs-only repo (no package.json)", async () => {
    const { runner, calls } = fakeRunner({});
    const result = await runNodeStep({
        ctx: baseCtx,
        trackedFiles: ["README.md", "docs/guide.md"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], "prettier");
    assert.equal(calls[0]![1], "--check");
});

test("check mode runs prettier --check with travelling config and the git-scoped file list", async () => {
    const { runner, calls } = fakeRunner({});
    const result = await runNodeStep({
        ctx: baseCtx,
        trackedFiles: ["package.json", "README.md", "scripts/setup.sh"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.equal(calls.length, 1);
    const [cmd, ...args] = calls[0]!;
    assert.equal(cmd, "prettier");
    assert.equal(args[0], "--check");
    assert.equal(args[1], "--config");
    assert.match(args[2]!, /runtime\/config\/prettier\.config\.mjs$/u);
    assert.equal(args[3], "--ignore-path");
    assert.match(args[4]!, /runtime\/config\/prettierignore$/u);
    // prettier gets exactly the parseable tracked files, never "." — build
    // dirs are gitignored so already absent, and .sh is not prettier's.
    assert.deepEqual(args.slice(5), ["package.json", "README.md"]);
});

test("fix mode writes then re-checks before reporting success", async () => {
    const { runner, calls } = fakeRunner({});
    const result = await runNodeStep({
        ctx: { ...baseCtx, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => (c[0] !== "prettier" ? c[0] : c[1])),
        ["--write", "--check"],
    );
});

test("a fix that leaves diffs can never read as success", async () => {
    let calls = 0;
    const runner = (({ cmd, args }: { cmd: string; args: string[] }) => {
        calls += 1;
        const status = calls === 1 ? 0 : 1;
        return { status, stdout: "", stderr: "" } satisfies CommandResult;
    }) as typeof import("../../lib/proc.mts").run;
    const result = await runNodeStep({
        ctx: { ...baseCtx, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "fail");
});

test("check mode failure names prettier and the file count", async () => {
    const { runner } = fakeRunner({
        prettier: { status: 1, stdout: "a.md\nb.md\nc.md\n" },
    });
    const result = await runNodeStep({
        ctx: baseCtx,
        trackedFiles: ["package.json"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("prettier"));
});

test("prettierIgnoreArgs passes the travelling ignore and adds the host .prettierignore when present", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-node-ignore-"));
    try {
        // No host file: single travelling ignore.
        const bare = await prettierIgnoreArgs({ repoRoot: root });
        assert.equal(bare.filter((a) => a === "--ignore-path").length, 1);
        assert.match(bare[1]!, /runtime\/config\/prettierignore$/u);

        // Host file present: second --ignore-path points at the repo root.
        await writeFile(join(root, ".prettierignore"), "dotfiles/nvim/\n");
        const withHost = await prettierIgnoreArgs({ repoRoot: root });
        assert.equal(withHost.filter((a) => a === "--ignore-path").length, 2);
        assert.equal(withHost[3], join(root, ".prettierignore"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
