// Tests for lib/ctx.mts: command parsing and run-context assembly.
// Run: node --test runtime/lib/ctx.test.mts

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createRunContext, parseCommand } from "./ctx.mts";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirs
            .splice(0)
            .map((dir) => rm(dir, { recursive: true, force: true })),
    );
});

async function tempGitTree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "quality-ctx-"));
    tempDirs.push(dir);
    await mkdir(join(dir, ".git"));
    return dir;
}

test("parseCommand_acceptsTheResultVerbs_defaultingToMin", () => {
    // Act & Assert
    assert.deepEqual(parseCommand({ argv: ["comply"] }), {
        verb: "comply",
        help: false,
        presentation: "min",
        timings: false,
    });

    // Act & Assert
    assert.deepEqual(parseCommand({ argv: ["verify"] }), {
        verb: "verify",
        help: false,
        presentation: "min",
        timings: false,
    });

    // Act & Assert
    assert.deepEqual(parseCommand({ argv: ["scan"] }), {
        verb: "scan",
        help: false,
        presentation: "min",
        timings: false,
    });
});

test("parseCommand_acceptsMinAndFullFlags", () => {
    // Act & Assert
    assert.deepEqual(parseCommand({ argv: ["comply", "--min"] }), {
        verb: "comply",
        help: false,
        presentation: "min",
        timings: false,
    });

    // Act & Assert
    assert.deepEqual(parseCommand({ argv: ["verify", "--full"] }), {
        verb: "verify",
        help: false,
        presentation: "full",
        timings: false,
    });
});

test("parseCommand_acceptsTimingsAloneAndAlongsidePresentation", () => {
    // Act & Assert
    assert.deepEqual(parseCommand({ argv: ["comply", "--timings"] }), {
        verb: "comply",
        help: false,
        presentation: "min",
        timings: true,
    });

    // Act & Assert
    assert.deepEqual(
        parseCommand({ argv: ["verify", "--full", "--timings"] }),
        {
            verb: "verify",
            help: false,
            presentation: "full",
            timings: true,
        },
    );

    // Act & Assert — scan takes the same presentation surface as the pair.
    assert.deepEqual(parseCommand({ argv: ["scan", "--full", "--timings"] }), {
        verb: "scan",
        help: false,
        presentation: "full",
        timings: true,
    });
});

test("parseCommand_rejectsConflictingPresentationFlags", () => {
    // Act & Assert
    assert.throws(
        () => parseCommand({ argv: ["comply", "--min", "--full"] }),
        /conflicting presentation flags/u,
    );
    // Act & Assert
    assert.throws(
        () => parseCommand({ argv: ["comply", "--full", "--min"] }),
        /conflicting presentation flags/u,
    );
});

test("parseCommand_acceptsExplainWithATopic", () => {
    // Act & Assert
    assert.deepEqual(parseCommand({ argv: ["explain", "shell"] }), {
        verb: "explain",
        help: false,
        presentation: "min",
        timings: false,
        topic: "shell",
    });

    // Act & Assert
    assert.deepEqual(parseCommand({ argv: ["explain", "SC2086"] }), {
        verb: "explain",
        help: false,
        presentation: "min",
        timings: false,
        topic: "SC2086",
    });
});

test("parseCommand_rejectsExplainWithoutATopic", () => {
    // Act & Assert
    assert.throws(() => parseCommand({ argv: ["explain"] }), /needs a topic/u);
    // Act & Assert
    assert.throws(
        () => parseCommand({ argv: ["explain", "--min"] }),
        /needs a topic/u,
    );
});

test("parseCommand_rejectsExtraExplainArguments", () => {
    // Act & Assert
    assert.throws(
        () => parseCommand({ argv: ["explain", "shell", "extra"] }),
        /unexpected argument/u,
    );
});

test("parseCommand_reportsHelp", () => {
    // Act & Assert
    assert.deepEqual(parseCommand({ argv: ["-h"] }), {
        verb: "verify",
        help: true,
        presentation: "min",
        timings: false,
    });

    // Act & Assert
    assert.deepEqual(parseCommand({ argv: ["--help"] }), {
        verb: "verify",
        help: true,
        presentation: "min",
        timings: false,
    });
});

test("parseCommand_rejectsAMissingCommand", () => {
    // Act & Assert
    assert.throws(() => parseCommand({ argv: [] }), /missing command/u);
});

test("parseCommand_rejectsUnknownVerbs", () => {
    // Act & Assert
    assert.throws(() => parseCommand({ argv: ["wat"] }), /unknown command/u);
    // Act & Assert
    assert.throws(() => parseCommand({ argv: ["setup"] }), /no longer public/u);
});

test("parseCommand_rejectsTheRetiredFlags", () => {
    // Act & Assert
    assert.throws(() => parseCommand({ argv: ["--fix"] }), /'--fix' is gone/u);
    // Act & Assert
    assert.throws(
        () => parseCommand({ argv: ["--no-fix"] }),
        /'--no-fix' is gone/u,
    );
    // Act & Assert
    assert.throws(
        () => parseCommand({ argv: ["--silent"] }),
        /'--silent' is gone/u,
    );
});

test("parseCommand_rejectsTrailingArguments", () => {
    // Act & Assert
    assert.throws(
        () => parseCommand({ argv: ["comply", "--silent"] }),
        /unexpected argument/u,
    );
    // Act & Assert
    assert.throws(
        () => parseCommand({ argv: ["verify", "extra"] }),
        /unexpected argument/u,
    );
});

test("createRunContext_derivesRepoRootViaGitMarkerWalkUp", async () => {
    // Arrange
    const root = await tempGitTree();
    const nested = join(root, "deep");
    await mkdir(nested);

    // Act
    const ctx = await createRunContext({
        verb: "verify",
        startDir: nested,
        presentation: "min",
        timings: true,
    });

    // Assert
    assert.equal(ctx.repoRoot, root);
    assert.equal(ctx.verb, "verify");
    assert.equal(ctx.presentation, "min");
    assert.equal(ctx.timings, true);
});

test("parseCommand_acceptsFilesValuesForScan", () => {
    // Act & Assert
    assert.deepEqual(
        parseCommand({
            argv: ["scan", "--files", "a.test.ts", "b.cs", "--full"],
        }),
        {
            verb: "scan",
            help: false,
            presentation: "full",
            timings: false,
            files: ["a.test.ts", "b.cs"],
        },
    );
});

test("parseCommand_rejectsFilesWithoutValues", () => {
    // Act & Assert
    assert.throws(
        () => parseCommand({ argv: ["scan", "--files"] }),
        /at least one path/u,
    );
});

test("parseCommand_rejectsFilesForVerify", () => {
    // Act & Assert
    assert.throws(
        () => parseCommand({ argv: ["verify", "--files", "a.test.ts"] }),
        /scan flag/u,
    );
});

test("createRunContext_resolvesNamedFilesAgainstTheRepo", async () => {
    // Arrange
    const dir = await tempGitTree();
    await mkdir(join(dir, "tests"));
    await writeFile(join(dir, "tests", "a.test.ts"), "", { flag: "w" });

    // Act
    const ctx = await createRunContext({
        verb: "scan",
        startDir: dir,
        presentation: "min",
        timings: false,
        files: ["tests/a.test.ts"],
    });

    // Assert
    assert.deepEqual(ctx.files, ["tests/a.test.ts"]);
});

test("createRunContext_rejectsANamedFileThatDoesNotExist", async () => {
    // Arrange
    const dir = await tempGitTree();

    // Act & Assert
    await assert.rejects(
        createRunContext({
            verb: "scan",
            startDir: dir,
            presentation: "min",
            timings: false,
            files: ["missing.test.ts"],
        }),
        /no such file/u,
    );
});
