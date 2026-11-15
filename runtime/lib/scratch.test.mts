// Tests for runtime/lib/scratch.mts: the no-fix scratch workspace for the
// dotnet steps.
// Run: node --test runtime/lib/scratch.test.mts

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { cleanupTempDirs, makeTempDir } from "../test-helpers.mts";
import { cleanupScratch, ensureScratch } from "./scratch.mts";

afterEach(cleanupTempDirs);

test("ensureScratch copies the git-scoped file list into a fresh dir", async () => {
    // Arrange
    const repoRoot = await makeTempDir("quality-scratch-");
    await writeFile(join(repoRoot, "App.csproj"), "<Project/>");
    await writeFile(join(repoRoot, ".editorconfig"), "root = true\n");
    const scratch = { dir: null as string | null };
    try {
        // Act
        const dir = ensureScratch({
            scratch,
            repoRoot,
            files: ["App.csproj", ".editorconfig"],
        });

        // Assert
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
    // Arrange
    const repoRoot = await makeTempDir("quality-scratch-");
    await mkdir(join(repoRoot, "src/Nested"), { recursive: true });
    await writeFile(join(repoRoot, "src/Nested/Deep.cs"), "namespace N;\n");
    const scratch = { dir: null as string | null };
    try {
        // Act
        const dir = ensureScratch({
            scratch,
            repoRoot,
            files: ["src/Nested/Deep.cs"],
        });

        // Assert
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
    // Arrange
    const repoRoot = await makeTempDir("quality-scratch-");
    await writeFile(join(repoRoot, "App.csproj"), "<Project/>");
    const scratch = { dir: null as string | null };
    try {
        const first = ensureScratch({
            scratch,
            repoRoot,
            files: ["App.csproj"],
        });

        // Act — a second call against the dir the first one made.
        const second = ensureScratch({
            scratch,
            repoRoot,
            files: ["App.csproj"],
        });

        // Assert
        assert.equal(second, first);
    } finally {
        cleanupScratch(scratch);
        await rm(repoRoot, { recursive: true, force: true });
    }
});

test("ensureScratch skips a stale path that no longer exists", async () => {
    // Arrange
    const repoRoot = await makeTempDir("quality-scratch-");
    await writeFile(join(repoRoot, "App.csproj"), "<Project/>");
    const scratch = { dir: null as string | null };
    try {
        // Act
        // A repair deleted Old.cs between the inventory snapshot and the
        // no-fix scratch copy; the stale path must not abort the copy (#62).
        const dir = ensureScratch({
            scratch,
            repoRoot,
            files: ["App.csproj", "Old.cs"],
        });

        // Assert
        assert.ok(existsSync(join(dir, "App.csproj")));
        assert.ok(!existsSync(join(dir, "Old.cs")));
    } finally {
        cleanupScratch(scratch);
        await rm(repoRoot, { recursive: true, force: true });
    }
});

test("cleanupScratch removes the dir and clears the box", async () => {
    // Arrange
    const repoRoot = await makeTempDir("quality-scratch-");
    await writeFile(join(repoRoot, "App.csproj"), "<Project/>");
    const scratch = { dir: null as string | null };
    const dir = ensureScratch({ scratch, repoRoot, files: ["App.csproj"] });

    // Act
    cleanupScratch(scratch);

    // Assert
    assert.equal(scratch.dir, null);
    assert.ok(!existsSync(dir));
    await rm(repoRoot, { recursive: true, force: true });
});

test("cleanupScratch is a no-op for an empty box", () => {
    // Act & Assert
    // The contract is "no throw and no unlink attempt" for a box nothing was
    // ever created in, so the assertion is the absence of an error.
    assert.doesNotThrow(() => cleanupScratch({ dir: null }));
});
