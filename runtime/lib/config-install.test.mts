// Tests for lib/config-install.mts: byte-identical root config install + check.
// Run: node --test lib/config-install.test.mts

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkRootConfigs, installRootConfigs } from "./config-install.mts";

interface Fixture {
    src: string;
    repo: string;
    root: string;
}

/** Create a temp source dir + repo root pair for an install run. */
async function makeFixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "quality-config-install-"));
    const src = join(root, "config");
    const repo = join(root, "repo");
    await mkdir(src);
    await mkdir(repo);
    return { src, repo, root };
}

/** Write a file inside the fixture's source dir. */
async function seedSource(
    src: string,
    files: Record<string, string>,
): Promise<void> {
    for (const [name, contents] of Object.entries(files)) {
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

test("installs the named absent files into the repo root", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, {
            ".editorconfig": "root = true\n",
            "Directory.Build.props": "<Project />\n",
        });

        const result = await installRootConfigs({
            sourceDir: src,
            names: [".editorconfig", "Directory.Build.props"],
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

test("leaves an identical existing file untouched and reports unchanged", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, { ".editorconfig": "root = true\n" });
        await writeFile(join(repo, ".editorconfig"), "root = true\n");

        const result = await installRootConfigs({
            sourceDir: src,
            names: [".editorconfig"],
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

test("reports drift on a differing existing file and never overwrites it", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, { ".editorconfig": "indent_size = 4\n" });
        await writeFile(join(repo, ".editorconfig"), "indent_size = 2\n");

        const result = await installRootConfigs({
            sourceDir: src,
            names: [".editorconfig"],
            repoRoot: repo,
        });
        assert.deepEqual(result, [{ name: ".editorconfig", status: "drift" }]);
        assert.equal(
            await readFile(join(repo, ".editorconfig"), "utf8"),
            "indent_size = 2\n",
        );
    });
});

test("drift does not stop the pass: later configs are still installed", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, {
            ".editorconfig": "indent_size = 4\n",
            ".gitattributes": "* text=auto eol=lf\n",
        });
        await writeFile(join(repo, ".editorconfig"), "indent_size = 2\n");

        const result = await installRootConfigs({
            sourceDir: src,
            names: [".editorconfig", ".gitattributes"],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            { name: ".editorconfig", status: "drift" },
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

        const result = await installRootConfigs({
            sourceDir: src,
            names: [".editorconfig"],
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
            await readFile(join(repo, "unrelated.sh"), "utf8")
                .then(() => "exists")
                .catch(() => "missing"),
            "missing",
        );
    });
});

test("re-running after a clean install is a no-op (unchanged)", async () => {
    await withFixture(async ({ src, repo }) => {
        await seedSource(src, { ".editorconfig": "root = true\n" });

        const opts = {
            sourceDir: src,
            names: [".editorconfig"],
            repoRoot: repo,
        };
        await installRootConfigs(opts);
        const second = await installRootConfigs(opts);
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

        const result = await checkRootConfigs({
            sourceDir: src,
            names: [".editorconfig", "Directory.Build.props"],
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

        const result = await checkRootConfigs({
            sourceDir: src,
            names: [".editorconfig"],
            repoRoot: repo,
        });
        assert.deepEqual(result, [
            { name: ".editorconfig", status: "present" },
        ]);
    });
});
