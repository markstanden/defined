// Tests for steps/naming.mts: workflow-filename grammar + consumer rules.
// Runner injected; no host binaries needed.
// Run: node --test steps/naming.test.mts

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import {
    filterWorkflowFiles,
    isValidWorkflowName,
    runNamingStep,
    workflowNameViolations,
} from "./naming.mts";
import { cleanupScratch } from "../lib/scratch.mts";
import { baseCtx, cleanupTempDirs, makeTempDir } from "../test-helpers.mts";
import type { CommandResult } from "../../lib/proc.mts";

afterEach(cleanupTempDirs);

type RunInput = { cmd: string; args: string[]; cwd?: string };

/** Records full runner input and maps each shell command to an outcome. */
function recordingRunner(
    outcomes: Record<string, { status: number; out?: string }> = {},
): {
    runner: typeof import("../../lib/proc.mts").run;
    calls: RunInput[];
} {
    const calls: RunInput[] = [];
    const runner = ((input: RunInput) => {
        calls.push(input);
        const command = input.args[1] ?? input.cmd;
        const outcome = outcomes[command] ?? { status: 0 };
        return {
            status: outcome.status,
            stdout: outcome.out ?? "",
            stderr: "",
        } satisfies CommandResult;
    }) as typeof import("../../lib/proc.mts").run;
    return { runner, calls };
}

test("filterWorkflowFiles keeps only .github/workflows yml/yaml", () => {
    assert.deepEqual(
        filterWorkflowFiles({
            files: [
                ".github/workflows/ci.yml",
                ".github/workflows/cd.yaml",
                ".github/dependabot.yml",
                "a.sh",
            ],
        }),
        [".github/workflows/ci.yml", ".github/workflows/cd.yaml"],
    );
});

test("isValidWorkflowName enforces <namespace>--<verb>[--<target>]", () => {
    for (const name of [
        "defined--verify.yml",
        "defined--publish.yml",
        "team--build--web.yml",
        "my-ns--run-tests.yaml",
    ]) {
        assert.ok(isValidWorkflowName({ name }), `${name} should be valid`);
    }
    for (const name of [
        "ci.yml",
        "defined-verify.yml",
        "Defined--verify.yml",
        "defined--.yml",
        "defined--verify.sh",
        "defined__verify.yml",
    ]) {
        assert.ok(!isValidWorkflowName({ name }), `${name} should be invalid`);
    }
});

test("workflowNameViolations names only the offending workflow files", () => {
    assert.deepEqual(
        workflowNameViolations({
            files: [
                ".github/workflows/defined--verify.yml",
                ".github/workflows/ci.yml",
                "a.sh",
            ],
        }),
        [".github/workflows/ci.yml"],
    );
});

test("runNamingStep skips when there are no workflows and no rules", async () => {
    const { runner, calls } = recordingRunner();
    const result = await runNamingStep({
        ctx: baseCtx,
        trackedFiles: ["a.sh"],
        runner,
    });
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("runNamingStep fails on a workflow filename that breaks the grammar", async () => {
    const { runner } = recordingRunner();
    const result = await runNamingStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /\.github\/workflows\/ci\.yml/u);
    assert.match(result.notice ?? "", /<namespace>--<verb>/u);
});

test("runNamingStep passes when workflow names follow the grammar", async () => {
    const { runner } = recordingRunner();
    const result = await runNamingStep({
        ctx: baseCtx,
        trackedFiles: [
            ".github/workflows/defined--verify.yml",
            ".github/workflows/defined--test.yml",
        ],
        runner,
    });
    assert.equal(result.status, "pass");
});

test("runNamingStep runs the consumer rules command in the repo (fix mode)", async () => {
    const root = await makeTempDir("quality-naming-");
    await writeFile(
        `${root}/.defined.json`,
        `${JSON.stringify({ naming: { command: "check-names.sh" } })}\n`,
    );
    const { runner, calls } = recordingRunner();
    const result = await runNamingStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: [],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => [c.args[1], c.cwd]),
        [["check-names.sh", root]],
    );
});

test("runNamingStep runs fix then the rules command in fix mode", async () => {
    const root = await makeTempDir("quality-naming-");
    await writeFile(
        `${root}/.defined.json`,
        `${JSON.stringify({
            naming: { command: "check-names.sh", fix: "fix-names.sh" },
        })}\n`,
    );
    const { runner, calls } = recordingRunner();
    const result = await runNamingStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: [],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => c.args[1]),
        ["fix-names.sh", "check-names.sh"],
    );
});

test("a failing consumer rules command fails the step", async () => {
    const root = await makeTempDir("quality-naming-");
    await writeFile(
        `${root}/.defined.json`,
        `${JSON.stringify({ naming: { command: "check-names.sh" } })}\n`,
    );
    const { runner } = recordingRunner({
        "check-names.sh": { status: 1, out: "bad name: fooBar" },
    });
    const result = await runNamingStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: [],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /rules failed/u);
    assert.match(result.notice ?? "", /bad name: fooBar/u);
});

test("no-fix runs the consumer rules in a scratch copy, never the repo", async () => {
    const root = await makeTempDir("quality-naming-");
    await writeFile(
        `${root}/.defined.json`,
        `${JSON.stringify({ naming: { command: "check-names.sh" } })}\n`,
    );
    await writeFile(`${root}/a.sh`, "#!/usr/bin/env bash\n");
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        const result = await runNamingStep({
            ctx: { ...baseCtx, repoRoot: root, mode: "no-fix", scratch },
            trackedFiles: ["a.sh"],
            runner,
        });
        assert.equal(result.status, "pass");
        assert.ok(scratch.dir !== null);
        assert.equal(calls[0]!.cwd, scratch.dir);
        assert.notEqual(calls[0]!.cwd, root);
    } finally {
        cleanupScratch(scratch);
    }
});
