// Tests for steps/shell.mts: shfmt + shellcheck over tracked shell scripts.
// The runner is injected, so no host binaries are needed here.
// Run: node --test steps/shell.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    filterShellScripts,
    parseShellcheck,
    parseShfmtFiles,
    runShellStep,
    SHELLCHECK_DEFAULT_FLOOR,
} from "./shell.mts";
import { baseCtx, fakeRunner } from "../test-helpers.mts";

test("filterShellScripts keeps only *.sh anywhere in the path", () => {
    assert.deepEqual(
        filterShellScripts({
            files: ["a.sh", "deep/nested/b.sh", "c.bash", "d", "e.sh.txt"],
        }),
        ["a.sh", "deep/nested/b.sh"],
    );
});

test("runShellStep skips cleanly when no shell scripts are tracked", async () => {
    const { runner } = fakeRunner({});
    const result = await runShellStep({
        ctx: baseCtx,
        trackedFiles: ["readme.md"],
        runner,
    });
    assert.equal(result.status, "skip");
});

test("check mode fails when shfmt lists an unformatted file", async () => {
    const { runner } = fakeRunner({
        shfmt: { status: 0, stdout: "broken.sh\n" },
        shellcheck: { status: 0 },
    });
    const result = await runShellStep({
        ctx: baseCtx,
        trackedFiles: ["broken.sh"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("shfmt"));
    assert.deepEqual(result.errors, [
        {
            kind: "finding",
            file: "broken.sh",
            message: "not shfmt-formatted (run shfmt -w)",
        },
    ]);
});

test("a nonzero shfmt exit is an execution error, not a finding", async () => {
    const { runner } = fakeRunner({
        shfmt: { status: 2, stderr: "cannot parse broken.sh" },
    });
    const result = await runShellStep({
        ctx: baseCtx,
        trackedFiles: ["broken.sh"],
        runner,
    });
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /shfmt failed/u);
});

test("parseShfmtFiles ignores blank lines and parseShellcheck reads gcc format", () => {
    assert.deepEqual(parseShfmtFiles({ stdout: "a.sh\n\nb.sh\n" }), [
        {
            kind: "finding",
            file: "a.sh",
            message: "not shfmt-formatted (run shfmt -w)",
        },
        {
            kind: "finding",
            file: "b.sh",
            message: "not shfmt-formatted (run shfmt -w)",
        },
    ]);
    assert.deepEqual(
        parseShellcheck({ text: "a.sh:2:5: warning: quote it [SC2086]\n" }),
        [
            {
                kind: "finding",
                file: "a.sh",
                line: 2,
                column: 5,
                rule: "SC2086",
                message: "quote it",
            },
        ],
    );
});

test("fix mode runs shfmt -w only, never the check (repair-only, #65)", async () => {
    const { runner, calls } = fakeRunner({});
    const result = await runShellStep({
        ctx: { ...baseCtx, mode: "fix" },
        trackedFiles: ["fixable.sh"],
        runner,
    });
    assert.equal(result.status, "pass");
    // Repair mutation only: one shfmt -w. No shfmt -l and no shellcheck — those
    // run once in the authoritative no-fix pass (#65).
    assert.deepEqual(calls, [["shfmt", "-w", "fixable.sh"]]);
});

test("shellcheck violations at or above the floor fail the step", async () => {
    const { runner } = fakeRunner({
        shfmt: { status: 0 },
        shellcheck: {
            status: 1,
            stdout: "bad.sh:1:1: error: note [SC1234]\n",
        },
    });
    const result = await runShellStep({
        ctx: baseCtx,
        trackedFiles: ["bad.sh"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("shellcheck"));
    assert.deepEqual(result.errors, [
        {
            kind: "finding",
            file: "bad.sh",
            line: 1,
            column: 1,
            rule: "SC1234",
            message: "note",
        },
    ]);
});

test("default floor is style; a raised project floor is honoured via -S", async () => {
    const { runner, calls } = fakeRunner({});
    await runShellStep({ ctx: baseCtx, trackedFiles: ["ok.sh"], runner });
    const floorArg = calls.find((c) => c[0] === "shellcheck")?.[
        calls.find((c) => c[0] === "shellcheck")!.indexOf("-S") + 1
    ];
    assert.equal(SHELLCHECK_DEFAULT_FLOOR, "style");
    assert.equal(floorArg, "style");
});
