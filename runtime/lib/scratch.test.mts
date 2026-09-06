// Tests for lib/scratch.mts: the no-fix scratch workspace for the dotnet steps.
// Run: node --test lib/scratch.test.mts

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { cleanupTempDirs, makeTempDir } from "../test-helpers.mts";
import { cleanupScratch, ensureScratch } from "./scratch.mts";

afterEach(cleanupTempDirs);

test("ensureScratch copies the git-scoped file list into a fresh dir", async () => {
    const repoRoot = await makeTempDir("quality-scratch-");
    await writeFile(join(repoRoot, "App.csproj"), "<Project/>");
    await writeFile(join(repoRoot, ".editorconfig"), "root = true\n");
    const scratch = { dir: null as string | null };
    try {
        const dir = ensureScratch({
            scratch,
            repoRoot,
            files: ["App.csproj", ".editorconfig"],
        });
        assert.notEqual(dir, repoRoot);
        assert.equal(scratch.dir, dir);
        assert.ok(existsSync(join(dir, "App.csproj")));
        assert.equal(
            await readFile(join(dir, ".editorconfig"), "utf8"),
            "root = true\n",
        );
    } finally {
        cleanupScratch(scratch);
        await rm(repoRoot, { recursive: true, force: true });
    }
});

test("ensureScratch copies nested files preserving the tree", async () => {
    const repoRoot = await makeTempDir("quality-scratch-");
    await mkdir(join(repoRoot, "src/Nested"), { recursive: true });
    await writeFile(join(repoRoot, "src/Nested/Deep.cs"), "namespace N;\n");
    const scratch = { dir: null as string | null };
    try {
        const dir = ensureScratch({
            scratch,
            repoRoot,
            files: ["src/Nested/Deep.cs"],
        });
        assert.equal(
            await readFile(join(dir, "src/Nested/Deep.cs"), "utf8"),
            "namespace N;\n",
        );
    } finally {
        cleanupScratch(scratch);
        await rm(repoRoot, { recursive: true, force: true });
    }
});

test("ensureScratch reuses an existing scratch dir", async () => {
    const repoRoot = await makeTempDir("quality-scratch-");
    await writeFile(join(repoRoot, "App.csproj"), "<Project/>");
    const scratch = { dir: null as string | null };
    try {
        const first = ensureScratch({
            scratch,
            repoRoot,
            files: ["App.csproj"],
        });
        const second = ensureScratch({
            scratch,
            repoRoot,
            files: ["App.csproj"],
        });
        assert.equal(second, first);
    } finally {
        cleanupScratch(scratch);
        await rm(repoRoot, { recursive: true, force: true });
    }
});

test("cleanupScratch removes the dir and clears the box", async () => {
    const repoRoot = await makeTempDir("quality-scratch-");
    await writeFile(join(repoRoot, "App.csproj"), "<Project/>");
    const scratch = { dir: null as string | null };
    const dir = ensureScratch({ scratch, repoRoot, files: ["App.csproj"] });
    cleanupScratch(scratch);
    assert.equal(scratch.dir, null);
    assert.ok(!existsSync(dir));
    await rm(repoRoot, { recursive: true, force: true });
});

test("cleanupScratch is a no-op for an empty box", () => {
    cleanupScratch({ dir: null });
});
