// Tests for lib/git.mts: git-tracked file discovery.
// Run: node --test lib/git.test.mts

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { run } from "./proc.mts";
import { trackedFiles } from "./git.mts";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirs
            .splice(0)
            .map((dir) => rm(dir, { recursive: true, force: true })),
    );
});

/** Create an isolated git repo with committed/untracked/ignored files. */
async function makeRepo({
    committed,
    untracked,
    ignored,
}: {
    committed?: string[];
    untracked?: string[];
    ignored?: string[];
}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "quality-git-"));
    tempDirs.push(root);

    run({ cmd: "git", args: ["init", "-q"], cwd: root });
    await writeFile(join(root, ".gitignore"), "*.ignored\n");
    for (const rel of [
        ".gitignore",
        ...(committed ?? []),
        ...(untracked ?? []),
        ...(ignored ?? []),
    ]) {
        if (rel === ".gitignore") continue;
        const abs = join(root, rel);
        await mkdir(join(abs, ".."), { recursive: true });
        await writeFile(abs, "#!/usr/bin/env bash\n");
    }
    if (committed?.length) {
        run({ cmd: "git", args: ["add", ...committed], cwd: root });
        run({
            cmd: "git",
            args: [
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "init",
            ],
            cwd: root,
        });
    }
    return root;
}

test("trackedFiles lists tracked and untracked-but-not-ignored files", async () => {
    const root = await makeRepo({ committed: ["a.sh"], untracked: ["b.sh"] });
    assert.deepEqual(
        (await Promise.resolve(trackedFiles({ repoRoot: root }))).sort(),
        [".gitignore", "a.sh", "b.sh"],
    );
});

test("trackedFiles excludes ignored and untracked-but-ignored files", async () => {
    const root = await makeRepo({
        committed: ["a.sh"],
        ignored: ["gen.ignored"],
    });
    assert.deepEqual(trackedFiles({ repoRoot: root }).sort(), [
        ".gitignore",
        "a.sh",
    ]);
});

test("trackedFiles drops deleted files and lists symlinks as themselves", async () => {
    const root = await makeRepo({ committed: ["gone.sh"] });
    await rm(join(root, "gone.sh"));
    await writeFile(join(root, "real.sh"), "x\n");
    await symlink(join(root, "real.sh"), join(root, "link.sh"));
    run({ cmd: "git", args: ["add", "link.sh"], cwd: root });

    const files = await trackedFiles({ repoRoot: root });
    assert.equal(files.includes("gone.sh"), false);
    assert.deepEqual(files.sort(), [".gitignore", "link.sh", "real.sh"]);
});

test("trackedFiles preserves spaces, quotes, tabs, unicode and newlines", async () => {
    const root = await makeRepo({ committed: ["with space.sh"] });
    const tricky = [
        "quote'name.sh",
        'double"name.sh',
        "tab\tname.sh",
        "unicode-✓-é.sh",
        "line\nbreak.sh",
    ];
    for (const rel of tricky) {
        await writeFile(join(root, rel), "x\n");
    }
    const files = trackedFiles({ repoRoot: root });
    for (const rel of tricky) {
        assert.ok(
            files.includes(rel),
            `${JSON.stringify(rel)} must survive the inventory`,
        );
    }
    assert.ok(files.includes("with space.sh"));
});

test("trackedFiles throws when the git inventory command fails", async () => {
    // A directory that is not a git repo: git exits non-zero, so the gate must
    // fail loudly rather than treat the empty output as a clean scope.
    const dir = await mkdtemp(join(tmpdir(), "quality-notgit-"));
    tempDirs.push(dir);
    assert.throws(
        () => trackedFiles({ repoRoot: dir }),
        /git ls-files failed/u,
    );
});
