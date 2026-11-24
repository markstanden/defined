// Tests for lib/node-packages.mts: package resolution and dependency restore
// shared by the node-deps and node-checks steps. Runner and existsSync
// injected; no host binaries needed.
// Run: node --test runtime/lib/node-packages.test.mts

import assert from "node:assert/strict";
import {
    appendFileSync,
    cpSync,
    existsSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
    defaultInstall,
    filterPackageJsons,
    packagesToRestore,
    resolvePackageDir,
    restoreNodePackages,
} from "./node-packages.mts";
import { cleanupTempDirs, fakeRunner, makeTempDir } from "../test-helpers.mts";

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
            files: ["package.json", "lib/package.json", "a.sh"],
        }),
        ["package.json", "lib/package.json"],
    );
});

test("resolvePackageDir uses the sole tracked package.json without a dir", () => {
    // Act & Assert
    assert.deepEqual(
        resolvePackageDir({
            files: ["lib/package.json", "a.sh"],
            dir: undefined,
        }),
        { dir: "lib" },
    );
});

test("resolvePackageDir rejects several packages without a dir", () => {
    // Act
    const resolved = resolvePackageDir({
        files: ["package.json", "lib/package.json"],
        dir: undefined,
    });

    // Assert
    assert.ok("error" in resolved);
    assert.match(resolved.error, /multiple package\.json/u);
});

test("resolvePackageDir honours an explicit root dir", () => {
    // Act & Assert
    assert.deepEqual(
        resolvePackageDir({ files: ["lib/package.json"], dir: "" }),
        { dir: "" },
    );
});

test("defaultInstall picks the lockfile's package manager, npm as fallback", () => {
    // Arrange
    const existsIn = (present: string[]) => (path: string) =>
        present.some((p) => path.endsWith(p));
    const cases = [
        { present: ["package-lock.json"], expected: "npm ci" },
        {
            present: ["yarn.lock"],
            expected: "yarn install --frozen-lockfile",
        },
        {
            present: ["pnpm-lock.yaml"],
            expected: "pnpm install --frozen-lockfile",
        },
        { present: [], expected: "npm install" },
    ];

    // Act
    const installs = cases.map(({ present }) =>
        defaultInstall({ packageDir: "/pkg", exists: existsIn(present) }),
    );

    // Assert
    assert.deepEqual(
        installs,
        cases.map(({ expected }) => expected),
    );
});

test("packagesToRestore leaves the declared list alone with no consumer config", () => {
    // Arrange
    const declared = [{ dir: "frontend" }];

    // Act & Assert
    assert.deepEqual(
        packagesToRestore({
            declared,
            trackedFiles: ["frontend/package.json", "package.json"],
        }),
        declared,
    );
});

test("packagesToRestore adds the root package when a consumer Prettier config is tracked", () => {
    // Act & Assert
    assert.deepEqual(
        packagesToRestore({
            declared: [],
            trackedFiles: ["package.json", "prettier.config.mjs"],
        }),
        [{ dir: "" }],
    );
});

test("packagesToRestore adds the root package for a consumer ESLint config", () => {
    // Act & Assert
    assert.deepEqual(
        packagesToRestore({
            declared: [],
            trackedFiles: [
                "package.json",
                "package-lock.json",
                "eslint.config.mjs",
            ],
        }),
        [{ dir: "" }],
    );
});

test("packagesToRestore skips the ESLint-triggered root when ESLint is disabled", () => {
    // Act & Assert
    assert.deepEqual(
        packagesToRestore({
            declared: [],
            trackedFiles: ["package.json", "eslint.config.mjs"],
            eslintEnabled: false,
        }),
        [],
    );
});

test("packagesToRestore dedupes two declarations for the same package", () => {
    // Arrange
    const cases = [
        { declared: [{ dir: "" }], trackedFiles: ["package.json"] },
        { declared: [{ dir: "app" }], trackedFiles: ["app/package.json"] },
    ];

    // Act
    const restored = cases.map((declaration) => packagesToRestore(declaration));

    // Assert
    assert.deepEqual(restored, [[{ dir: "" }], [{ dir: "app" }]]);
});

test("packagesToRestore never duplicates a declared root and honours its opt-out", () => {
    // Arrange
    // A declared root (even install:false) owns the root: no auto-added copy.
    const declared = [{ dir: "", install: false }];

    // Act & Assert
    assert.deepEqual(
        packagesToRestore({
            declared,
            trackedFiles: ["package.json", "prettier.config.mjs"],
        }),
        declared,
    );
});

test("restoreNodePackages restores each distinct directory once", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-packages-");
    await writeTree(root, { "package.json": "{}\n" });
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: root,
        trackedFiles: ["package.json"],
        packages: [{ dir: "" }, { dir: "" }],
        runner,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 1, reused: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.at(-1), root);
});

test("restoreNodePackages reports a missing manifest and installs nothing", async () => {
    // Arrange
    const root = await makeTempDir("quality-node-packages-");
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: root,
        trackedFiles: ["package.json"],
        packages: [{ dir: "" }],
        runner,
    });

    // Assert
    assert.deepEqual(result.failures, ["no package.json at ."]);
    assert.equal(result.restored, 0);
    assert.equal(calls.length, 0);
});

// --- Warm-tree reuse in the no-fix scratch (#67) -----------------------------
// A frozen-lockfile install is deterministic: identical manifest + lockfile
// bytes must produce the identical tree, so the repo's warm tree can be
// copied into the scratch instead of reinstalling it. Arbitrary install
// commands and the no-lockfile `npm install` fallback are nondeterministic
// and never reuse.

const MANIFEST = '{"name":"bench","private":true}\n';
const LOCKFILE = '{"lockfileVersion":3,"packages":{}}\n';

async function warmFixture({
    repoTree = true,
    lockfile = LOCKFILE,
}: {
    repoTree?: boolean;
    lockfile?: string;
} = {}): Promise<{ repo: string; scratch: string }> {
    const repo = await makeTempDir("quality-node-packages-");
    const scratch = await makeTempDir("quality-node-packages-");
    const repoFiles: Record<string, string> = {
        "package.json": MANIFEST,
        "package-lock.json": lockfile,
    };
    if (repoTree) {
        repoFiles["node_modules/.warm"] = "warm tree\n";
    }
    await writeTree(repo, repoFiles);
    await writeTree(scratch, {
        "package.json": MANIFEST,
        "package-lock.json": LOCKFILE,
    });
    return { repo, scratch };
}

test("restoreNodePackages copies a matching warm tree instead of installing", async () => {
    // Arrange
    const { repo, scratch } = await warmFixture();
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: scratch,
        trackedFiles: ["package.json", "package-lock.json"],
        packages: [{ dir: "" }],
        runner,
        warmRoot: repo,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 0, reused: 1 });
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(scratch, "node_modules/.warm")), true);
});

test("restoreNodePackages reinstalls when the warm lockfile differs", async () => {
    // Arrange
    const { repo, scratch } = await warmFixture({
        lockfile: '{"lockfileVersion":3,"packages":{"stale":{}}}\n',
    });
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: scratch,
        trackedFiles: ["package.json", "package-lock.json"],
        packages: [{ dir: "" }],
        runner,
        warmRoot: repo,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 1, reused: 0 });
    assert.equal(calls.length, 1);
});

test("restoreNodePackages reinstalls when no warm tree exists", async () => {
    // Arrange
    const { repo, scratch } = await warmFixture({ repoTree: false });
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: scratch,
        trackedFiles: ["package.json", "package-lock.json"],
        packages: [{ dir: "" }],
        runner,
        warmRoot: repo,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 1, reused: 0 });
    assert.equal(calls.length, 1);
});

test("restoreNodePackages falls back to an install when the copy fails", async () => {
    // Arrange
    const { repo, scratch } = await warmFixture();
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: scratch,
        trackedFiles: ["package.json", "package-lock.json"],
        packages: [{ dir: "" }],
        runner,
        warmRoot: repo,
        copyFn: () => {
            throw new Error("source vanished mid-copy");
        },
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 1, reused: 0 });
    assert.equal(calls.length, 1);
});

test("restoreNodePackages discards a warm copy that changes mid-copy", async () => {
    // Arrange
    const { repo, scratch } = await warmFixture();
    const { runner, calls } = fakeRunner({}, true);
    const source = join(repo, "node_modules/.warm");
    let destinationPresentAtInstall: boolean | null = null;
    const checkingRunner: typeof runner = async (input) => {
        destinationPresentAtInstall = existsSync(join(scratch, "node_modules"));
        return runner(input);
    };
    let first = true;
    const copyFn: typeof cpSync = (from: string, to: string) => {
        cpSync(from, to, { recursive: true });
        if (first) {
            first = false;
            appendFileSync(source, "rebuilt under the copy\n");
        }
    };

    // Act
    const result = await restoreNodePackages({
        workingRoot: scratch,
        trackedFiles: ["package.json", "package-lock.json"],
        packages: [{ dir: "" }],
        runner: checkingRunner,
        warmRoot: repo,
        copyFn,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 1, reused: 0 });
    assert.equal(calls.length, 1);
    assert.equal(destinationPresentAtInstall, false);
});

test("restoreNodePackages discards a warm copy that gains an entry mid-copy", async () => {
    // Arrange
    const { repo, scratch } = await warmFixture();
    const { runner, calls } = fakeRunner({}, true);
    let first = true;
    const copyFn: typeof cpSync = (from: string, to: string) => {
        cpSync(from, to, { recursive: true });
        if (first) {
            first = false;
            writeFileSync(join(repo, "node_modules/added.js"), "new\n");
        }
    };

    // Act
    const result = await restoreNodePackages({
        workingRoot: scratch,
        trackedFiles: ["package.json", "package-lock.json"],
        packages: [{ dir: "" }],
        runner,
        warmRoot: repo,
        copyFn,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 1, reused: 0 });
    assert.equal(calls.length, 1);
});

test("restoreNodePackages never reuses a symlinked warm tree", async () => {
    // Arrange
    const { repo, scratch } = await warmFixture({ repoTree: false });
    const store = await makeTempDir("quality-node-packages-store-");
    await writeTree(store, { ".warm": "warm tree\n" });
    symlinkSync(store, join(repo, "node_modules"), "dir");
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: scratch,
        trackedFiles: ["package.json", "package-lock.json"],
        packages: [{ dir: "" }],
        runner,
        warmRoot: repo,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 1, reused: 0 });
    assert.equal(calls.length, 1);
});

test("restoreNodePackages never reuses a declared install command", async () => {
    // Arrange
    const { repo, scratch } = await warmFixture();
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: scratch,
        trackedFiles: ["package.json", "package-lock.json"],
        packages: [{ dir: "", install: "npm ci" }],
        runner,
        warmRoot: repo,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 1, reused: 0 });
    assert.equal(calls.length, 1);
});

test("restoreNodePackages does not reuse the no-lockfile npm install fallback", async () => {
    // Arrange
    const repo = await makeTempDir("quality-node-packages-");
    const scratch = await makeTempDir("quality-node-packages-");
    await writeTree(repo, {
        "package.json": MANIFEST,
        "node_modules/.warm": "warm tree\n",
    });
    await writeTree(scratch, { "package.json": MANIFEST });
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: scratch,
        trackedFiles: ["package.json"],
        packages: [{ dir: "" }],
        runner,
        warmRoot: repo,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 1, reused: 0 });
    assert.equal(calls.length, 1);
});

test("restoreNodePackages skips the install when the working root is the warm root", async () => {
    // Arrange
    const repo = await makeTempDir("quality-node-packages-");
    await writeTree(repo, {
        "package.json": MANIFEST,
        "package-lock.json": LOCKFILE,
        "node_modules/.warm": "warm tree\n",
    });
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: repo,
        trackedFiles: ["package.json", "package-lock.json"],
        packages: [{ dir: "" }],
        runner,
        warmRoot: repo,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 0, reused: 1 });
    assert.equal(calls.length, 0);
});

test("restoreNodePackages counts install:false as neither restored nor reused", async () => {
    // Arrange
    const { repo, scratch } = await warmFixture();
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await restoreNodePackages({
        workingRoot: scratch,
        trackedFiles: ["package.json", "package-lock.json"],
        packages: [{ dir: "", install: false }],
        runner,
        warmRoot: repo,
    });

    // Assert
    assert.deepEqual(result, { failures: [], restored: 0, reused: 0 });
    assert.equal(calls.length, 0);
});
