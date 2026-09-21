// Tests for lib/managed-files.mts: mode-aware install + check of shared files.
// Run: node --test lib/managed-files.test.mts

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { checkManagedFiles, installManagedFiles } from "./managed-files.mts";

interface Fixture {
    src: string;
    repo: string;
    root: string;
}

/** Create a temp source dir + repo root pair for an install run. */
async function makeFixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "quality-managed-files-"));
    const src = join(root, "config");
    const repo = join(root, "repo");
    await mkdir(src);
    await mkdir(repo);
    return { src, repo, root };
}

/** Write files inside the fixture's source dir, creating parents. */
async function seedSource(
    src: string,
    files: Record<string, string>,
): Promise<void> {
    for (const [name, contents] of Object.entries(files)) {
        await mkdir(dirname(join(src, name)), { recursive: true });
        await writeFile(join(src, name), contents);
    }
}

/** Run a test body against a fresh fixture, always cleaning up. */
async function withFixture<T>(
    fn: (fixture: Fixture) => Promise<T>,
): Promise<T> {
    const fixture = await makeFixture();
    try {
        return await fn(fixture);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
}

/** True when a path exists and is readable. */
async function exists(filePath: string): Promise<boolean> {
    try {
        await readFile(filePath);
        return true;
    } catch {
        return false;
    }
}

test("installs the named absent files into the repo root", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, {
            ".editorconfig": "root = true\n",
            "Directory.Build.props": "<Project />\n",
        });

        const result = await installManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: ".editorconfig",
                    target: ".editorconfig",
                    mode: "seeded",
                },
                {
                    source: "Directory.Build.props",
                    target: "Directory.Build.props",
                    mode: "seeded",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            { name: ".editorconfig", status: "installed" },
            { name: "Directory.Build.props", status: "installed" },
        ]);
        assert.equal(
            await readFile(join(repo, ".editorconfig"), "utf8"),
            "root = true\n",
        );
        assert.equal(
            await readFile(join(repo, "Directory.Build.props"), "utf8"),
            "<Project />\n",
        );
    });
});

test("installs a file whose source and target paths differ, creating parents", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, {
            "workflows/defined--verify.yml": "name: Gate\n",
        });

        const result = await installManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: "workflows/defined--verify.yml",
                    target: ".github/workflows/defined--verify.yml",
                    mode: "managed",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            {
                name: ".github/workflows/defined--verify.yml",
                status: "installed",
            },
        ]);
        assert.equal(
            await readFile(
                join(repo, ".github/workflows/defined--verify.yml"),
                "utf8",
            ),
            "name: Gate\n",
            "the source path is not where the file lands",
        );
    });
});

test("leaves an identical existing file untouched and reports unchanged", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, { ".editorconfig": "root = true\n" });
        await writeFile(join(repo, ".editorconfig"), "root = true\n");

        const result = await installManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: ".editorconfig",
                    target: ".editorconfig",
                    mode: "seeded",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            { name: ".editorconfig", status: "unchanged" },
        ]);
        assert.equal(
            await readFile(join(repo, ".editorconfig"), "utf8"),
            "root = true\n",
        );
    });
});

test("keeps a differing seeded file: never overwritten, reported kept", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, { ".editorconfig": "indent_size = 4\n" });
        await writeFile(join(repo, ".editorconfig"), "indent_size = 2\n");

        const result = await installManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: ".editorconfig",
                    target: ".editorconfig",
                    mode: "seeded",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, [{ name: ".editorconfig", status: "kept" }]);
        assert.equal(
            await readFile(join(repo, ".editorconfig"), "utf8"),
            "indent_size = 2\n",
            "a seeded default never overwrites the repo's own rules",
        );
    });
});

test("overwrites a differing managed file and reports updated", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, {
            "workflows/defined--verify.yml": "name: Gate\n",
        });
        const target = join(repo, ".github/workflows/defined--verify.yml");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, "name: Stale\n");

        const result = await installManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: "workflows/defined--verify.yml",
                    target: ".github/workflows/defined--verify.yml",
                    mode: "managed",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            {
                name: ".github/workflows/defined--verify.yml",
                status: "updated",
            },
        ]);
        assert.equal(
            await readFile(target, "utf8"),
            "name: Gate\n",
            "a managed file is brought back to the gate copy",
        );
    });
});

test("a kept seeded file does not stop the pass: later files still install", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, {
            ".editorconfig": "indent_size = 4\n",
            ".gitattributes": "* text=auto eol=lf\n",
        });
        await writeFile(join(repo, ".editorconfig"), "indent_size = 2\n");

        const result = await installManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: ".editorconfig",
                    target: ".editorconfig",
                    mode: "seeded",
                },
                {
                    source: ".gitattributes",
                    target: ".gitattributes",
                    mode: "seeded",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            { name: ".editorconfig", status: "kept" },
            { name: ".gitattributes", status: "installed" },
        ]);
    });
});

test("installs only the named files, ignoring others in the source dir", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, {
            ".editorconfig": "root = true\n",
            "unrelated.sh": "echo hi\n",
        });

        const result = await installManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: ".editorconfig",
                    target: ".editorconfig",
                    mode: "seeded",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            { name: ".editorconfig", status: "installed" },
        ]);
        assert.equal(
            await readFile(join(repo, ".editorconfig"), "utf8"),
            "root = true\n",
        );
        assert.equal(
            await exists(join(repo, "unrelated.sh")),
            false,
            "only the named files are copied into the repo",
        );
    });
});

test("re-running after a clean install is a no-op (unchanged)", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, { ".editorconfig": "root = true\n" });

        const opts = {
            sourceDir: src,
            files: [
                {
                    source: ".editorconfig",
                    target: ".editorconfig",
                    mode: "seeded",
                },
            ],
            repoRoot: repo,
        };
        await installManagedFiles(opts);
        const second = await installManagedFiles(opts);
        assert.deepEqual(second, [
            { name: ".editorconfig", status: "unchanged" },
        ]);
    });
});

test("check reports present, absent and drift without writing", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, {
            ".editorconfig": "root = true\n",
            "Directory.Build.props": "<Project />\n",
        });
        await writeFile(join(repo, "Directory.Build.props"), "changed\n");

        const result = await checkManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: ".editorconfig",
                    target: ".editorconfig",
                    mode: "managed",
                },
                {
                    source: "Directory.Build.props",
                    target: "Directory.Build.props",
                    mode: "managed",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            { name: ".editorconfig", status: "absent" },
            { name: "Directory.Build.props", status: "drift" },
        ]);
        assert.equal(
            await readFile(join(repo, "Directory.Build.props"), "utf8"),
            "changed\n",
        );
    });
});

test("check reports present for an identical existing file", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, { ".editorconfig": "root = true\n" });
        await writeFile(join(repo, ".editorconfig"), "root = true\n");

        const result = await checkManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: ".editorconfig",
                    target: ".editorconfig",
                    mode: "managed",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            { name: ".editorconfig", status: "present" },
        ]);
    });
});

test("check reports a mapped target absent when only the source path exists", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, {
            "workflows/defined--verify.yml": "name: Gate\n",
        });
        // The consumer has the source-shaped path, not the installed target.
        await mkdir(join(repo, "workflows"), { recursive: true });
        await writeFile(
            join(repo, "workflows/defined--verify.yml"),
            "name: Gate\n",
        );

        const result = await checkManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: "workflows/defined--verify.yml",
                    target: ".github/workflows/defined--verify.yml",
                    mode: "managed",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            { name: ".github/workflows/defined--verify.yml", status: "absent" },
        ]);
    });
});

test("check skips seeded files: a repo's own default is never gated", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, {
            ".editorconfig": "root = true\n",
            "Directory.Build.props": "<Project />\n",
        });
        await writeFile(join(repo, ".editorconfig"), "indent_size = 2\n");

        const result = await checkManagedFiles({
            sourceDir: src,
            files: [
                {
                    source: ".editorconfig",
                    target: ".editorconfig",
                    mode: "seeded",
                },
                {
                    source: "Directory.Build.props",
                    target: "Directory.Build.props",
                    mode: "seeded",
                },
            ],
            repoRoot: repo,
        });
        assert.deepEqual(result, []);
    });
});
