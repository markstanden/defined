// Tests for lib/paths.mts: symlink resolution and repo-root derivation.
// Run: node --test lib/paths.test.mts

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deriveRepoRoot, resolveRealPath } from "./paths.mts";

async function makeTempTree(): Promise<string> {
    return mkdtemp(join(tmpdir(), "quality-paths-"));
}

test("resolveRealPath resolves a symlinked directory to its target", async () => {
    // Arrange
    const root = await makeTempTree();
    try {
        const real = join(root, "real");
        const link = join(root, "link");
        await mkdir(real);
        await symlink(real, link);

        // Act & Assert
        assert.equal(await resolveRealPath({ path: link }), real);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("resolveRealPath returns an already-real path unchanged", async () => {
    // Arrange
    const root = await makeTempTree();
    try {
        const real = join(root, "real");
        await mkdir(real);

        // Act & Assert
        assert.equal(await resolveRealPath({ path: real }), real);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("deriveRepoRoot walks up from a nested directory to the .git dir", async () => {
    // Arrange
    const root = await makeTempTree();
    try {
        await mkdir(join(root, ".git"));
        const nested = join(root, "a", "b", "c");
        await mkdir(nested, { recursive: true });

        // Act & Assert
        assert.equal(await deriveRepoRoot({ startDir: nested }), root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("deriveRepoRoot treats a .git file (worktree/submodule) as a root marker", async () => {
    // Arrange
    const root = await makeTempTree();
    try {
        await writeFile(join(root, ".git"), "gitdir: /somewhere/else\n");

        // Act & Assert
        assert.equal(await deriveRepoRoot({ startDir: root }), root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("deriveRepoRoot stops at the nearest .git, not an ancestor's", async () => {
    // Arrange
    const outer = await makeTempTree();
    try {
        await mkdir(join(outer, ".git"));
        const inner = join(outer, "project");
        await mkdir(inner);
        await mkdir(join(inner, ".git"));
        const nested = join(inner, "src");
        await mkdir(nested);

        // Act & Assert
        assert.equal(await deriveRepoRoot({ startDir: nested }), inner);
    } finally {
        await rm(outer, { recursive: true, force: true });
    }
});

test("deriveRepoRoot resolves symlinks in the start path first", async () => {
    // Arrange
    const root = await makeTempTree();
    try {
        await mkdir(join(root, ".git"));
        const real = join(root, "project", "src");
        await mkdir(real, { recursive: true });
        await mkdir(join(root, "project", ".git"));
        const viaLink = join(root, "alias");
        await symlink(real, viaLink);

        // Act & Assert
        assert.equal(
            await deriveRepoRoot({ startDir: viaLink }),
            join(root, "project"),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
