// Tests for lib/ctx.mts: command parsing and run-context assembly.
// Run: node --test runtime/lib/ctx.test.mts

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

test("parseCommand_acceptsExactlyComplyAndVerify_defaultingToMin", () => {
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
