// Tests for lib/ownership-drift.mts: advisory notices for consumer overrides
// that weaken the house floor and for project-owned seeded defaults that
// differ from the image-baked copies.
// Run: node --test runtime/lib/ownership-drift.test.mts

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { DefinedConfig } from "./config.mts";
import type { ManagedFile } from "./managed-files.mts";
import { configDrift, ownershipDrift } from "./ownership-drift.mts";

const EMPTY_CONFIG: DefinedConfig = { version: "" };

function seededFile(source: string, target: string): ManagedFile {
    return { source, target, mode: "seeded" };
}

async function withSourceDir(
    files: Record<string, string>,
    act: (sourceDir: string) => Promise<void>,
): Promise<void> {
    const sourceDir = await mkdtemp(join(tmpdir(), "drift-source-"));
    try {
        for (const [name, contents] of Object.entries(files)) {
            await mkdir(dirname(join(sourceDir, name)), { recursive: true });
            await writeFile(join(sourceDir, name), contents);
        }
        await act(sourceDir);
    } finally {
        await rm(sourceDir, { recursive: true, force: true });
    }
}

async function withRepo(
    files: Record<string, string>,
    act: (repoRoot: string) => Promise<void>,
): Promise<void> {
    const repoRoot = await mkdtemp(join(tmpdir(), "drift-repo-"));
    try {
        for (const [name, contents] of Object.entries(files)) {
            await mkdir(dirname(join(repoRoot, name)), { recursive: true });
            await writeFile(join(repoRoot, name), contents);
        }
        await act(repoRoot);
    } finally {
        await rm(repoRoot, { recursive: true, force: true });
    }
}

test("ownershipDrift_cleanConfigAndIdenticalSeeds_isEmpty", async () => {
    // Arrange
    await withSourceDir(
        { ".editorconfig": "root = true\n" },
        async (sourceDir) => {
            await withRepo(
                { ".editorconfig": "root = true\n" },
                async (repoRoot) => {
                    // Act
                    const notices = await ownershipDrift({
                        config: EMPTY_CONFIG,
                        sourceDir,
                        files: [seededFile(".editorconfig", ".editorconfig")],
                        repoRoot,
                    });

                    // Assert
                    assert.deepEqual(notices, []);
                },
            );
        },
    );
});

test("ownershipDrift_eslintDisabled_reportsWeakenedHouseFloor", async () => {
    // Arrange
    await withSourceDir(
        { ".editorconfig": "root = true\n" },
        async (sourceDir) => {
            await withRepo(
                { ".editorconfig": "root = true\n" },
                async (repoRoot) => {
                    // Act
                    const notices = await ownershipDrift({
                        config: { version: "", eslint: { disable: true } },
                        sourceDir,
                        files: [seededFile(".editorconfig", ".editorconfig")],
                        repoRoot,
                    });

                    // Assert
                    assert.equal(notices.length, 1);
                    assert.equal(notices[0].kind, "config");
                    assert.equal(notices[0].file, ".defined.json");
                    assert.match(notices[0].message, /eslint\.disable/u);
                },
            );
        },
    );
});

test("ownershipDrift_dotnetAndWorkflowDisabled_eachReportOneNotice", async () => {
    // Arrange
    await withSourceDir(
        { ".editorconfig": "root = true\n" },
        async (sourceDir) => {
            await withRepo(
                { ".editorconfig": "root = true\n" },
                async (repoRoot) => {
                    // Act
                    const notices = await ownershipDrift({
                        config: {
                            version: "",
                            dotnet: { disable: true },
                            workflow: { disable: true },
                        },
                        sourceDir,
                        files: [seededFile(".editorconfig", ".editorconfig")],
                        repoRoot,
                    });

                    // Assert
                    assert.equal(notices.length, 2);
                    assert.ok(
                        notices.every((notice) => notice.kind === "config"),
                    );
                    assert.match(
                        notices.map((notice) => notice.message).join("\n"),
                        /dotnet\.disable/u,
                    );
                    assert.match(
                        notices.map((notice) => notice.message).join("\n"),
                        /workflow\.disable/u,
                    );
                },
            );
        },
    );
});

test("ownershipDrift_coverageLineBelowHouseMinimum_reportsOneNotice", async () => {
    // Arrange
    await withSourceDir(
        { ".editorconfig": "root = true\n" },
        async (sourceDir) => {
            await withRepo(
                { ".editorconfig": "root = true\n" },
                async (repoRoot) => {
                    // Act
                    const notices = await ownershipDrift({
                        config: {
                            version: "",
                            coverage: {
                                node: {
                                    command: "npm run test:coverage",
                                    minimums: { line: 60 },
                                },
                            },
                        },
                        sourceDir,
                        files: [seededFile(".editorconfig", ".editorconfig")],
                        repoRoot,
                    });

                    // Assert
                    assert.equal(notices.length, 1);
                    assert.equal(notices[0].kind, "config");
                    assert.match(
                        notices[0].message,
                        /coverage\.node\.minimums\.line/u,
                    );
                    assert.match(notices[0].message, /80/u);
                },
            );
        },
    );
});

test("ownershipDrift_coverageLineAtHouseMinimum_reportsNothing", async () => {
    // Arrange
    await withSourceDir(
        { ".editorconfig": "root = true\n" },
        async (sourceDir) => {
            await withRepo(
                { ".editorconfig": "root = true\n" },
                async (repoRoot) => {
                    // Act
                    const notices = await ownershipDrift({
                        config: {
                            version: "",
                            coverage: {
                                dotnet: {
                                    command: "dotnet test",
                                    minimums: { line: 80 },
                                },
                            },
                        },
                        sourceDir,
                        files: [seededFile(".editorconfig", ".editorconfig")],
                        repoRoot,
                    });

                    // Assert
                    assert.deepEqual(notices, []);
                },
            );
        },
    );
});

test("ownershipDrift_edgeOfRange_coverageLineAboveHouseMinimum_reportsNothing", async () => {
    // Arrange
    await withSourceDir(
        { ".editorconfig": "root = true\n" },
        async (sourceDir) => {
            await withRepo(
                { ".editorconfig": "root = true\n" },
                async (repoRoot) => {
                    // Act
                    const notices = await ownershipDrift({
                        config: {
                            version: "",
                            coverage: {
                                node: {
                                    command: "npm run test:coverage",
                                    minimums: { line: 81 },
                                },
                            },
                        },
                        sourceDir,
                        files: [seededFile(".editorconfig", ".editorconfig")],
                        repoRoot,
                    });

                    // Assert
                    assert.deepEqual(notices, []);
                },
            );
        },
    );
});

test("ownershipDrift_seededFileDiffers_reportsProjectOwnedDrift", async () => {
    // Arrange
    await withSourceDir(
        {
            ".editorconfig": "root = true\nend_of_line = lf\n",
            ".gitattributes": "* text=auto eol=lf\n",
        },
        async (sourceDir) => {
            await withRepo(
                {
                    ".editorconfig": "root = true\nend_of_line = crlf\n",
                },
                async (repoRoot) => {
                    // Act
                    const notices = await ownershipDrift({
                        config: EMPTY_CONFIG,
                        sourceDir,
                        files: [
                            seededFile(".editorconfig", ".editorconfig"),
                            seededFile(".gitattributes", ".gitattributes"),
                        ],
                        repoRoot,
                    });

                    // Assert
                    assert.equal(notices.length, 1);
                    assert.equal(notices[0].kind, "seeded");
                    assert.equal(notices[0].file, ".editorconfig");
                    assert.match(notices[0].message, /house default/u);
                },
            );
        },
    );
});

test("ownershipDrift_absentSeededFile_isRepoChoiceNotDrift", async () => {
    // Arrange
    await withSourceDir(
        { ".editorconfig": "root = true\n" },
        async (sourceDir) => {
            await withRepo({}, async (repoRoot) => {
                // Act
                const notices = await ownershipDrift({
                    config: EMPTY_CONFIG,
                    sourceDir,
                    files: [seededFile(".editorconfig", ".editorconfig")],
                    repoRoot,
                });

                // Assert
                assert.deepEqual(notices, []);
            });
        },
    );
});

test("ownershipDrift_managedFileDiffers_isNotAdvisoryDrift", async () => {
    // Arrange
    await withSourceDir(
        { "workflows/defined--verify.yml": "gate\n" },
        async (sourceDir) => {
            await withRepo(
                { ".github/workflows/defined--verify.yml": "changed\n" },
                async (repoRoot) => {
                    // Act
                    const notices = await ownershipDrift({
                        config: EMPTY_CONFIG,
                        sourceDir,
                        files: [
                            {
                                source: "workflows/defined--verify.yml",
                                target: ".github/workflows/defined--verify.yml",
                                mode: "managed",
                            },
                        ],
                        repoRoot,
                    });

                    // Assert
                    assert.deepEqual(notices, []);
                },
            );
        },
    );
});

test("ownershipDrift_scopeInclude_reportsTheNarrowedScope", async () => {
    // Arrange
    await withSourceDir(
        { ".editorconfig": "root = true\n" },
        async (sourceDir) => {
            await withRepo(
                { ".editorconfig": "root = true\n" },
                async (repoRoot) => {
                    // Act
                    const notices = await ownershipDrift({
                        config: {
                            version: "",
                            scope: { include: ["src/**", "tests/**"] },
                        },
                        sourceDir,
                        files: [seededFile(".editorconfig", ".editorconfig")],
                        repoRoot,
                    });

                    // Assert
                    assert.equal(notices.length, 1);
                    assert.equal(notices[0].kind, "config");
                    assert.equal(notices[0].file, ".defined.json");
                    assert.match(
                        notices[0].message,
                        /scope\.include: narrows the content checks to 2 selector\(s\)/u,
                    );
                },
            );
        },
    );
});

test("configDrift_reportsScopeWithoutTheBootstrapPhase", () => {
    // Act
    const notices = configDrift({
        version: "",
        scope: { include: ["src/**"] },
    });

    // Assert
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, "config");
    assert.match(notices[0].message, /1 selector\(s\)/u);
});
