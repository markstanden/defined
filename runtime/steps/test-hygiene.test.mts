// Tests for steps/test-hygiene.mts: the always-on rule pass as a gate step.
// Run: node --test runtime/steps/test-hygiene.test.mts

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runTestHygieneStep } from "./test-hygiene.mts";

/** A reader that serves the given sources by repo-relative path. */
function readerFor(sources: Record<string, string>) {
    return async (path: string): Promise<string> => {
        const key = path.replace(/^\/repo\//u, "");
        const content = sources[key];
        if (content === undefined) {
            throw new Error(`unexpected read: ${path}`);
        }
        return content;
    };
}

test("skips in fix mode", async () => {
    // Arrange
    const sources = { "a.test.ts": 'it.only("works", () => {});' };

    // Act
    const result = await runTestHygieneStep({
        ctx: { mode: "fix", repoRoot: "/repo" },
        trackedFiles: ["a.test.ts"],
        reader: readerFor(sources),
    });

    // Assert
    assert.equal(result.status, "skip");
});

test("skips when no tracked file is a source", async () => {
    // Act
    const result = await runTestHygieneStep({
        ctx: { mode: "no-fix", repoRoot: "/repo" },
        trackedFiles: ["README.md", "assets/logo.png"],
        reader: readerFor({}),
    });

    // Assert
    assert.equal(result.status, "skip");
});

test("passes when the sources are clean", async () => {
    // Arrange
    const sources = {
        "a.test.ts":
            'import { it } from "node:test";\nimport assert from "node:assert/strict";\n\nit("works", () => {\n    assert.equal(value(), 1);\n});\n',
    };

    // Act
    const result = await runTestHygieneStep({
        ctx: { mode: "no-fix", repoRoot: "/repo" },
        trackedFiles: ["a.test.ts"],
        reader: readerFor(sources),
    });

    // Assert
    assert.equal(result.status, "pass");
    assert.match(result.notice ?? "", /1 file\(s\) clean/u);
});

test("fails with one diagnostic per finding", async () => {
    // Arrange
    const sources = {
        "a.test.ts":
            'import { it } from "node:test";\n\nit.only("works", () => {\n    setup();\n});\n',
    };

    // Act
    const result = await runTestHygieneStep({
        ctx: { mode: "no-fix", repoRoot: "/repo" },
        trackedFiles: ["a.test.ts"],
        reader: readerFor(sources),
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.deepEqual(
        result.errors?.map((error) => ({
            kind: error.kind,
            rule: error.rule,
            file: error.file,
            line: error.line,
        })),
        [
            {
                kind: "finding",
                rule: "focused-test",
                file: "a.test.ts",
                line: 3,
            },
            {
                kind: "finding",
                rule: "no-assertions",
                file: "a.test.ts",
                line: 3,
            },
        ],
    );
});

test("reports a collection finding through the step", async () => {
    // Arrange
    const sources = {
        "requests/users.yml": [
            "info:",
            "  name: Get users",
            "  type: http",
            "http:",
            "  method: GET",
            "  url: {{baseUrl}}/users",
        ].join("\n"),
    };

    // Act
    const result = await runTestHygieneStep({
        ctx: { mode: "no-fix", repoRoot: "/repo" },
        trackedFiles: ["requests/users.yml"],
        reader: readerFor(sources),
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.deepEqual(
        result.errors?.map((error) => [error.rule, error.file]),
        [["no-tests", "requests/users.yml"]],
    );
});

test("errors when a source cannot be read", async () => {
    // Arrange
    const reader = async (): Promise<string> => {
        throw new Error("permission denied");
    };

    // Act
    const result = await runTestHygieneStep({
        ctx: { mode: "no-fix", repoRoot: "/repo" },
        trackedFiles: ["a.test.ts"],
        reader,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /could not read "a\.test\.ts"/u);
    assert.match(result.notice ?? "", /permission denied/u);
});

test("reads exactly the named files, untracked ones included", async () => {
    // Arrange
    const sources = {
        "fresh.test.ts":
            'import { it } from "node:test";\n\nit("works", () => {\n    setup();\n});\n',
    };

    // Act
    const result = await runTestHygieneStep({
        ctx: { mode: "no-fix", repoRoot: "/repo" },
        trackedFiles: [],
        reviewFiles: ["fresh.test.ts"],
        reader: readerFor(sources),
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.deepEqual(
        result.errors?.map((error) => [error.rule, error.file]),
        [["no-assertions", "fresh.test.ts"]],
    );
});

test("fails a named review lead and stays silent in tracked mode", async () => {
    // Arrange
    const sources = {
        "lead.test.ts":
            'import { it } from "node:test";\nimport assert from "node:assert/strict";\n\nit("waits", async () => {\n    await sleep(5);\n    assert.equal(value(), 1);\n});\n',
    };
    const run = (reviewFiles?: string[]) =>
        runTestHygieneStep({
            ctx: { mode: "no-fix", repoRoot: "/repo" },
            trackedFiles: ["lead.test.ts"],
            ...(reviewFiles === undefined ? {} : { reviewFiles }),
            reader: readerFor(sources),
        });

    // Act
    const tracked = await run();
    const reviewed = await run(["lead.test.ts"]);

    // Assert
    assert.equal(tracked.status, "pass");
    assert.equal(reviewed.status, "fail");
    assert.deepEqual(
        reviewed.errors?.map((error) => error.rule),
        ["sleep"],
    );
});

test("reads a named file from disk", async () => {
    // Arrange
    const repoRoot = await mkdtemp(join(tmpdir(), "quality-hygiene-"));
    await mkdir(join(repoRoot, "tests"));
    await writeFile(
        join(repoRoot, "tests", "bad.test.ts"),
        'import { it } from "node:test";\nimport assert from "node:assert/strict";\n\nit.only("works", () => {\n    assert.equal(value(), 1);\n});\n',
    );
    try {
        // Act
        const result = await runTestHygieneStep({
            ctx: { mode: "no-fix", repoRoot },
            trackedFiles: [],
            reviewFiles: ["tests/bad.test.ts"],
        });

        // Assert
        assert.equal(result.status, "fail");
        assert.deepEqual(
            result.errors?.map((error) => error.rule),
            ["focused-test"],
        );
    } finally {
        await rm(repoRoot, { recursive: true, force: true });
    }
});
