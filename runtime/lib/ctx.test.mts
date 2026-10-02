// Tests for lib/ctx.mts: command parsing and run-context assembly.
// Run: node --test lib/ctx.test.mts

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
    assert.deepEqual(parseCommand({ argv: ["comply"] }), {
        verb: "comply",
        help: false,
        presentation: "min",
        timings: false,
    });
    assert.deepEqual(parseCommand({ argv: ["verify"] }), {
        verb: "verify",
        help: false,
        presentation: "min",
        timings: false,
    });
});

test("parseCommand_acceptsMinAndFullFlags", () => {
    assert.deepEqual(parseCommand({ argv: ["comply", "--min"] }), {
        verb: "comply",
        help: false,
        presentation: "min",
        timings: false,
    });
    assert.deepEqual(parseCommand({ argv: ["verify", "--full"] }), {
        verb: "verify",
        help: false,
        presentation: "full",
        timings: false,
    });
});

test("parseCommand_acceptsTimingsAloneAndAlongsidePresentation", () => {
    assert.deepEqual(parseCommand({ argv: ["comply", "--timings"] }), {
        verb: "comply",
        help: false,
        presentation: "min",
        timings: true,
    });
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
    assert.throws(
        () => parseCommand({ argv: ["comply", "--min", "--full"] }),
        /conflicting presentation flags/u,
    );
    assert.throws(
        () => parseCommand({ argv: ["comply", "--full", "--min"] }),
        /conflicting presentation flags/u,
    );
});

test("parseCommand_acceptsExplainWithATopic", () => {
    assert.deepEqual(parseCommand({ argv: ["explain", "shell"] }), {
        verb: "explain",
        help: false,
        presentation: "min",
        timings: false,
        topic: "shell",
    });
    assert.deepEqual(parseCommand({ argv: ["explain", "SC2086"] }), {
        verb: "explain",
        help: false,
        presentation: "min",
        timings: false,
        topic: "SC2086",
    });
});

test("parseCommand_rejectsExplainWithoutATopic", () => {
    assert.throws(() => parseCommand({ argv: ["explain"] }), /needs a topic/u);
    assert.throws(
        () => parseCommand({ argv: ["explain", "--min"] }),
        /needs a topic/u,
    );
});

test("parseCommand_rejectsExtraExplainArguments", () => {
    assert.throws(
        () => parseCommand({ argv: ["explain", "shell", "extra"] }),
        /unexpected argument/u,
    );
});

test("parseCommand_reportsHelp", () => {
    assert.deepEqual(parseCommand({ argv: ["-h"] }), {
        verb: "verify",
        help: true,
        presentation: "min",
        timings: false,
    });
    assert.deepEqual(parseCommand({ argv: ["--help"] }), {
        verb: "verify",
        help: true,
        presentation: "min",
        timings: false,
    });
});

test("parseCommand_rejectsAMissingCommand", () => {
    assert.throws(() => parseCommand({ argv: [] }), /missing command/u);
});

test("parseCommand_rejectsUnknownVerbs", () => {
    assert.throws(() => parseCommand({ argv: ["wat"] }), /unknown command/u);
    assert.throws(() => parseCommand({ argv: ["setup"] }), /no longer public/u);
});

test("parseCommand_rejectsTheRetiredFlags", () => {
    assert.throws(() => parseCommand({ argv: ["--fix"] }), /'--fix' is gone/u);
    assert.throws(
        () => parseCommand({ argv: ["--no-fix"] }),
        /'--no-fix' is gone/u,
    );
    assert.throws(
        () => parseCommand({ argv: ["--silent"] }),
        /'--silent' is gone/u,
    );
});

test("parseCommand_rejectsTrailingArguments", () => {
    assert.throws(
        () => parseCommand({ argv: ["comply", "--silent"] }),
        /unexpected argument/u,
    );
    assert.throws(
        () => parseCommand({ argv: ["verify", "extra"] }),
        /unexpected argument/u,
    );
});

test("createRunContext_derivesRepoRootViaGitMarkerWalkUp", async () => {
    const root = await tempGitTree();
    const nested = join(root, "deep");
    await mkdir(nested);
    const ctx = await createRunContext({
        verb: "verify",
        startDir: nested,
        presentation: "min",
        timings: true,
    });
    assert.equal(ctx.repoRoot, root);
    assert.equal(ctx.verb, "verify");
    assert.equal(ctx.presentation, "min");
    assert.equal(ctx.timings, true);
});
