// Tests for steps/node.mts: repo-wide formatting via prettier.
// Runner injected, so no host binaries are needed here.
// Run: node --test runtime/steps/node.test.mts

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
    filterMarkdownFiles,
    filterPrettierFiles,
    parsePrettierFindings,
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
    // Act & Assert
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
    // Act & Assert
    assert.deepEqual(
        filterMarkdownFiles({
            files: ["README.md", "docs/guide.md", "a.sh", "b.yml"],
        }),
        ["README.md", "docs/guide.md"],
    );
});

test("filterPrettierFiles keeps parseable extensions and drops the rest", () => {
    // Act & Assert
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
    // Arrange
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runNodeStep({
        ctx: baseCtx,
        trackedFiles: ["a.sh", "b.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("runNodeStep runs prettier for a docs-only repo (no package.json)", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-");
    await writeTree(root, {
        "README.md": "# title\n",
        "docs/guide.md": "# guide\n",
    });
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        // Act
        const result = await runNodeStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["README.md", "docs/guide.md"],
            runner,
        });

        // Assert
        assert.equal(result.status, "pass");
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.cmd, "prettier");
        assert.equal(calls[0]!.args[0], "--check");
    } finally {
        cleanupScratch(scratch);
    }
});

test("check mode runs prettier --check in the scratch working root with the git-scoped file list", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-");
    await writeTree(root, {
        "package.json": "{}\n",
        "README.md": "# title\n",
        "scripts/setup.sh": "#!/usr/bin/env bash\n",
    });
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        // Act
        const result = await runNodeStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["package.json", "README.md", "scripts/setup.sh"],
            runner,
        });

        // Assert
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

test("fix mode runs the write only and never re-checks (repair-only, #65)", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-");
    await writeTree(root, { "package.json": "{}\n" });
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runNodeStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    // Repair mutation only: one prettier --write. The check runs once in the
    // authoritative no-fix pass, never here (#65).
    assert.deepEqual(
        calls.map((c) => c.args[0]),
        ["--write"],
    );
    // Fix mode works in the repo itself.
    assert.equal(calls[0]!.cwd, root);
});

test("a prettier --write that fails is an execution error", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-");
    await writeTree(root, { "package.json": "{}\n" });
    const { runner } = recordingRunner({
        prettier: { status: 1, stderr: "write barfed" },
    });

    // Act
    const result = await runNodeStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["package.json"],
        runner,
    });

    // Assert
    assert.equal(result.status, "error");
});

test("parsePrettierFindings names each unformatted file and skips the summary", () => {
    // Act
    const errors = parsePrettierFindings({
        stdout: [
            "Checking formatting...",
            "[warn] src/a.ts",
            "[warn] docs/b.md",
            "[warn] Code style issues found in 2 files. Run Prettier with --write to fix.",
            "",
        ].join("\n"),
    });

    // Assert
    assert.deepEqual(errors, [
        {
            kind: "finding",
            file: "src/a.ts",
            message: "unformatted (run prettier --write)",
        },
        {
            kind: "finding",
            file: "docs/b.md",
            message: "unformatted (run prettier --write)",
        },
    ]);
});

test("check mode failure reports each unformatted file as a diagnostic", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-");
    await writeTree(root, { "package.json": "{}\n" });
    const scratch = { dir: null };
    const { runner } = recordingRunner({
        prettier: {
            status: 1,
            stdout: "[warn] a.md\n[warn] b.md\n[warn] Code style issues found in 2 files.\n",
        },
    });
    try {
        // Act
        const result = await runNodeStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["package.json"],
            runner,
        });

        // Assert
        assert.equal(result.status, "fail");
        assert.match(result.notice ?? "", /prettier found 2 unformatted/u);
        assert.deepEqual(
            result.errors?.map((error) => error.file),
            ["a.md", "b.md"],
        );
    } finally {
        cleanupScratch(scratch);
    }
});

test("prettierIgnoreArgs passes the travelling ignore when the repo has none", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-ignore-");

    // Act
    const args = await prettierIgnoreArgs({ repoRoot: root });

    // Assert
    assert.equal(args.filter((a) => a === "--ignore-path").length, 1);
    assert.match(args[1]!, /runtime\/config\/prettierignore$/u);
});

test("prettierIgnoreArgs adds the host .prettierignore when present", async () => {
    // Arrange — a host file at the repo root adds a second --ignore-path.
    const root = await makeTempDir("quality-node-ignore-");
    await writeFile(join(root, ".prettierignore"), "dotfiles/nvim/\n");

    // Act
    const args = await prettierIgnoreArgs({ repoRoot: root });

    // Assert
    assert.equal(args.filter((a) => a === "--ignore-path").length, 2);
    assert.equal(args[3], join(root, ".prettierignore"));
});

test("prettierConfigArgs falls back to the travelling config with no consumer file", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-config-bare-");

    // Act
    const args = await prettierConfigArgs({ repoRoot: root });

    // Assert
    assert.equal(args[0], "--config");
    assert.match(args[1]!, /runtime\/config\/prettier\.config\.mjs$/u);
});

test("a consumer-owned prettier config replaces the travelling default", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-config-");
    await writeTree(root, {
        "package.json": "{}\n",
        "prettier.config.mjs": "export default {};\n",
    });
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        // Act
        const result = await runNodeStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["package.json", "prettier.config.mjs"],
            runner,
        });

        // Assert
        assert.equal(result.status, "pass");
        const call = calls[0]!;
        assert.equal(call.args[1], "--config");
        // The config is the scratch copy, beside the restored dependencies.
        assert.equal(call.args[2], join(scratch.dir!, "prettier.config.mjs"));
    } finally {
        cleanupScratch(scratch);
    }
});

/**
 * A fake prettier that reports exactly the files in `dirty` as unformatted and
 * records the file list it was handed each call. Lets a test drive per-file
 * cache hits without a real binary.
 */
function checkedRunner(dirty: Set<string>): {
    runner: typeof import("../../lib/proc.mts").run;
    calls: string[][];
} {
    const calls: string[][] = [];
    const runner = (async ({ args }: { args: string[] }) => {
        // args: --check --config <cfg> --ignore-path <ig> <files...>
        const files = args.slice(5);
        calls.push(files);
        const flagged = files.filter((file) => dirty.has(file));
        return {
            status: flagged.length > 0 ? 1 : 0,
            stdout: flagged.map((file) => `[warn] ${file}`).join("\n"),
            stderr: "",
            signal: null,
            timedOut: false,
            cancelled: false,
            truncated: false,
        };
    }) as typeof import("../../lib/proc.mts").run;
    return { runner, calls };
}

test("an unchanged scope is served from the cache with no prettier process", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-cache-hit-");
    await writeTree(root, { "a.md": "# a\n", "b.md": "# b\n" });
    const cacheDir = await makeTempDir("quality-node-cache-");
    const ctx = {
        ...baseCtx,
        repoRoot: root,
        scratch: { dir: root },
        cacheDir,
    };
    const notes: string[] = [];

    const first = checkedRunner(new Set(["a.md", "b.md"]));

    // Act
    const r1 = await runNodeStep({
        ctx,
        trackedFiles: ["a.md", "b.md"],
        runner: first.runner,
    });

    // Assert
    assert.equal(r1.status, "fail");
    assert.deepEqual(first.calls, [["a.md", "b.md"]]);

    // Arrange
    const second = checkedRunner(new Set(["a.md", "b.md"]));

    // Act
    const r2 = await runNodeStep({
        ctx: { ...ctx, notify: (line) => notes.push(line) },
        trackedFiles: ["a.md", "b.md"],
        runner: second.runner,
    });

    // Assert
    assert.equal(r2.status, "fail");
    assert.deepEqual(second.calls, [], "all files cached: no process");
    assert.deepEqual(
        r2.errors?.map((error) => error.file),
        ["a.md", "b.md"],
    );
    assert.deepEqual(notes, ["defined: cache node hit=2 miss=0"]);
});

test("editing one file re-checks only that file", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-cache-edit-");
    await writeTree(root, { "a.md": "# a\n", "b.md": "# b\n" });
    const cacheDir = await makeTempDir("quality-node-cache-");
    const ctx = {
        ...baseCtx,
        repoRoot: root,
        scratch: { dir: root },
        cacheDir,
    };

    const clean = checkedRunner(new Set());
    await runNodeStep({
        ctx,
        trackedFiles: ["a.md", "b.md"],
        runner: clean.runner,
    });

    await writeFile(join(root, "a.md"), "# a changed\n");
    const edited = checkedRunner(new Set(["a.md"]));

    // Act
    const result = await runNodeStep({
        ctx,
        trackedFiles: ["a.md", "b.md"],
        runner: edited.runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.deepEqual(
        edited.calls,
        [["a.md"]],
        "only the edited file is re-run",
    );
    assert.deepEqual(
        result.errors?.map((error) => error.file),
        ["a.md"],
    );
});

test("added and deleted files are handled by the per-file keys", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-cache-scope-");
    await writeTree(root, { "a.md": "# a\n" });
    const cacheDir = await makeTempDir("quality-node-cache-");
    const ctx = {
        ...baseCtx,
        repoRoot: root,
        scratch: { dir: root },
        cacheDir,
    };

    await runNodeStep({
        ctx,
        trackedFiles: ["a.md"],
        runner: checkedRunner(new Set()).runner,
    });

    // A new file is a miss; a deleted file simply leaves the key set.
    await writeTree(root, { "b.md": "# b\n" });
    const added = checkedRunner(new Set());

    // Act
    const withNew = await runNodeStep({
        ctx,
        trackedFiles: ["a.md", "b.md"],
        runner: added.runner,
    });

    // Assert
    assert.equal(withNew.status, "pass");
    assert.deepEqual(added.calls, [["b.md"]]);

    // Arrange
    const afterDelete = checkedRunner(new Set());

    // Act
    await runNodeStep({
        ctx,
        trackedFiles: ["a.md"],
        runner: afterDelete.runner,
    });

    // Assert
    assert.deepEqual(afterDelete.calls, [], "a.md stays a hit");
});

test("cached and uncached runs agree on the verdict", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-cache-agree-");
    await writeTree(root, { "a.md": "# a\n", "b.md": "# b\n" });
    const cacheDir = await makeTempDir("quality-node-cache-");
    const ctx = {
        ...baseCtx,
        repoRoot: root,
        scratch: { dir: root },
        cacheDir,
    };
    const dirty = new Set(["a.md"]);

    // Act
    const cached = await runNodeStep({
        ctx,
        trackedFiles: ["a.md", "b.md"],
        runner: checkedRunner(dirty).runner,
    });
    const uncached = await runNodeStep({
        ctx: { ...baseCtx, repoRoot: root, scratch: { dir: root } },
        trackedFiles: ["a.md", "b.md"],
        runner: checkedRunner(dirty).runner,
    });

    // Assert
    assert.equal(cached.status, uncached.status);
    assert.deepEqual(cached.errors, uncached.errors);
});

test("a consumer prettier config bypasses the cache", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-cache-bypass-");
    await writeTree(root, {
        "prettier.config.mjs": "export default {};\n",
        "a.md": "# a\n",
    });
    const cacheDir = await makeTempDir("quality-node-cache-");
    const ctx = {
        ...baseCtx,
        repoRoot: root,
        scratch: { dir: root },
        cacheDir,
    };
    const notes: string[] = [];

    for (let run = 0; run < 2; run += 1) {
        const runner = checkedRunner(new Set());
        await runNodeStep({
            ctx: { ...ctx, notify: (line) => notes.push(line) },
            trackedFiles: ["prettier.config.mjs", "a.md"],
            runner: runner.runner,
        });
        // Act & Assert
        assert.equal(runner.calls.length, 1, "each run still spawns");
    }

    // Assert
    assert.deepEqual(notes, [], "no cache metric when bypassed");
});
