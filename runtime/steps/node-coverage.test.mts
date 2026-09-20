// Tests for steps/node-coverage.mts: lcov parser + minimum gate.
// Runner injected, so no host binaries are needed here.
// Run: node --test steps/node-coverage.test.mts

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import type { CommandResult } from "../../lib/proc.mts";
import {
    checkMinimums,
    parseLcov,
    runNodeCoverageStep,
} from "./node-coverage.mts";
import { cleanupScratch } from "../lib/scratch.mts";
import {
    cleanupTempDirs,
    makeTempDir,
    runCoverageScenario,
    setupCoverageRepo,
    TEST_SHA,
} from "../test-helpers.mts";

afterEach(cleanupTempDirs);

/**
 * A runner that simulates the consumer's coverage command: on `sh` it writes
 * the given lcov report into `cwd` (the repo in fix mode, the scratch in
 * no-fix) and records every call.
 */
function reportWriterRunner({
    calls,
    lcov,
}: {
    calls: string[][];
    lcov: string;
}): typeof import("../../lib/proc.mts").run {
    return (({ cmd, args, cwd }) => {
        calls.push([cmd, ...args, cwd ?? ""]);
        if (cmd === "sh") {
            const target = join(cwd!, "coverage/lcov.info");
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, lcov);
        }
        return { status: 0, stdout: "", stderr: "" } satisfies CommandResult;
    }) as typeof import("../../lib/proc.mts").run;
}

// --- parseLcov ---

test("parseLcov extracts line totals from lcov content", () => {
    const content = [
        "SF:/src/index.ts",
        "DA:1,5",
        "DA:2,0",
        "DA:3,10",
        "end_of_record",
        "LF:3",
        "LH:2",
        "BRF:4",
        "BRH:3",
        "FNF:5",
        "FNH:4",
    ].join("\n");
    const summary = parseLcov({ content });
    assert.equal(summary.linesFound, 3);
    assert.equal(summary.linesHit, 2);
    assert.equal(summary.branchesFound, 4);
    assert.equal(summary.branchesHit, 3);
    assert.equal(summary.functionsFound, 5);
    assert.equal(summary.functionsHit, 4);
});

test("parseLcov aggregates across multiple source files", () => {
    const content = [
        "SF:/src/a.ts",
        "DA:1,5",
        "LF:2",
        "LH:1",
        "BRF:2",
        "BRH:1",
        "FNF:2",
        "FNH:1",
        "end_of_record",
        "SF:/src/b.ts",
        "DA:1,3",
        "LF:3",
        "LH:3",
        "BRF:4",
        "BRH:4",
        "FNF:3",
        "FNH:3",
        "end_of_record",
    ].join("\n");
    const summary = parseLcov({ content });
    assert.equal(summary.linesFound, 5);
    assert.equal(summary.linesHit, 4);
    assert.equal(summary.branchesFound, 6);
    assert.equal(summary.branchesHit, 5);
    assert.equal(summary.functionsFound, 5);
    assert.equal(summary.functionsHit, 4);
});

test("parseLcov returns zeros for empty content", () => {
    const summary = parseLcov({ content: "" });
    assert.equal(summary.linesFound, 0);
    assert.equal(summary.linesHit, 0);
    assert.equal(summary.branchesFound, 0);
    assert.equal(summary.branchesHit, 0);
    assert.equal(summary.functionsFound, 0);
    assert.equal(summary.functionsHit, 0);
});

// --- checkMinimums ---

test("checkMinimums passes when above minimum", () => {
    const result = checkMinimums({
        summary: {
            linesFound: 100,
            linesHit: 90,
            branchesFound: 0,
            branchesHit: 0,
            functionsFound: 0,
            functionsHit: 0,
        },
        minimums: { line: 80 },
    });
    assert.equal(result.pass, true);
    assert.equal(result.failures.length, 0);
});

test("checkMinimums fails when below minimum", () => {
    const result = checkMinimums({
        summary: {
            linesFound: 100,
            linesHit: 70,
            branchesFound: 0,
            branchesHit: 0,
            functionsFound: 0,
            functionsHit: 0,
        },
        minimums: { line: 80 },
    });
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /line:.*70\.0%.*80%/u);
});

test("checkMinimums checks branch when configured", () => {
    const result = checkMinimums({
        summary: {
            linesFound: 100,
            linesHit: 90,
            branchesFound: 50,
            branchesHit: 30,
            functionsFound: 0,
            functionsHit: 0,
        },
        minimums: { line: 80, branch: 70 },
    });
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /branch:.*60\.0%.*70%/u);
});

test("checkMinimums checks function when configured", () => {
    const result = checkMinimums({
        summary: {
            linesFound: 100,
            linesHit: 90,
            branchesFound: 0,
            branchesHit: 0,
            functionsFound: 10,
            functionsHit: 5,
        },
        minimums: { line: 80, function: 70 },
    });
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /function:.*50\.0%.*70%/u);
});

test("checkMinimums reports multiple failures", () => {
    const result = checkMinimums({
        summary: {
            linesFound: 100,
            linesHit: 50,
            branchesFound: 100,
            branchesHit: 50,
            functionsFound: 10,
            functionsHit: 4,
        },
        minimums: { line: 80, branch: 70, function: 60 },
    });
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 3);
});

test("checkMinimums treats zero lines found as 0%", () => {
    const result = checkMinimums({
        summary: {
            linesFound: 0,
            linesHit: 0,
            branchesFound: 0,
            branchesHit: 0,
            functionsFound: 0,
            functionsHit: 0,
        },
        minimums: { line: 80 },
    });
    assert.equal(result.pass, false);
});

// --- runNodeCoverageStep ---

test("skips when no coverage.node in config", async () => {
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({ root: dir, config: { version: TEST_SHA } });
    const { result, calls } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        trackedFiles: ["package.json"],
    });
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("skips when no .defined.json exists", async () => {
    const dir = await makeTempDir("quality-nc-");
    const { result, calls } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        trackedFiles: ["package.json"],
    });
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("fails when fix mode command fails", async () => {
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({
        root: dir,
        config: { version: TEST_SHA, coverage: { node: { command: "false" } } },
    });
    const { result } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        mode: "fix",
        trackedFiles: ["package.json"],
        runnerOutcomes: { sh: { status: 1, stderr: "boom" } },
    });
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /coverage command failed/u);
});

test("fails when no lcov.info after fix mode command", async () => {
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { node: { command: "echo ok" } },
        },
    });
    const { result } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        mode: "fix",
        trackedFiles: ["package.json"],
        runnerOutcomes: { sh: { status: 0 } },
    });
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /no coverage report/u);
});

test("gates line coverage against the effective minimum", async () => {
    const SCENARIOS = [
        {
            label: "meets default 80%",
            minimums: undefined,
            lh: 85,
            re: /85\.0%/u,
            status: "pass",
        },
        {
            label: "below default 80%",
            minimums: undefined,
            lh: 50,
            re: /50\.0%.*80%/u,
            status: "fail",
        },
        {
            label: "meets custom 50%",
            minimums: { line: 50 },
            lh: 60,
            re: /60\.0%/u,
            status: "pass",
        },
    ] as const;
    for (const { label, minimums, lh, re, status } of SCENARIOS) {
        const config: Record<string, unknown> = {
            version: TEST_SHA,
            coverage: { node: { command: "npm t" } },
        };
        if (minimums) {
            (
                config.coverage as { node: { minimums?: unknown } }
            ).node.minimums = minimums;
        }
        const dir = await makeTempDir("quality-nc-");
        await setupCoverageRepo({
            root: dir,
            config,
            reportPath: "coverage/lcov.info",
            reportContent: ["LF:100", `LH:${lh}`].join("\n"),
        });
        const { result } = await runCoverageScenario({
            step: runNodeCoverageStep,
            repoRoot: dir,
            mode: "fix",
            trackedFiles: ["package.json"],
        });
        assert.equal(result.status, status, label);
        assert.match(result.notice ?? "", re, label);
    }
});

test("no-fix runs the coverage command in a scratch workspace, isolated from the repo", async () => {
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({
        root: dir,
        config: { version: TEST_SHA, coverage: { node: { command: "npm t" } } },
        // A report in the repo must NOT satisfy the pass: no-fix runs the
        // command in the scratch (left empty by the fake) and reads the report
        // from there too, so the repo's report is invisible.
        reportPath: "coverage/lcov.info",
        reportContent: ["LF:100", "LH:90"].join("\n"),
    });
    await writeFile(join(dir, "package.json"), "{}");
    const calls: string[][] = [];
    const scratch = { dir: null as string | null };
    try {
        const runner = (({ cmd, args, cwd }) => {
            calls.push([cmd, ...args, cwd ?? ""]);
            return {
                status: 0,
                stdout: "",
                stderr: "",
            } satisfies CommandResult;
        }) as typeof import("../../lib/proc.mts").run;
        const result = await runNodeCoverageStep({
            ctx: { mode: "no-fix", repoRoot: dir, scratch },
            trackedFiles: ["package.json"],
            runner,
        });
        assert.equal(result.status, "fail");
        assert.match(result.notice ?? "", /no coverage report/u);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]![0], "sh");
        const runCwd = calls[0]!.at(-1)!;
        assert.notEqual(runCwd, dir);
        assert.equal(scratch.dir, runCwd);
    } finally {
        cleanupScratch(scratch);
    }
});

test("no-fix validates the report the command writes into the scratch", async () => {
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({
        root: dir,
        config: { version: TEST_SHA, coverage: { node: { command: "npm t" } } },
    });
    await writeFile(join(dir, "package.json"), "{}");
    const calls: string[][] = [];
    const scratch = { dir: null as string | null };
    try {
        const result = await runNodeCoverageStep({
            ctx: { mode: "no-fix", repoRoot: dir, scratch },
            trackedFiles: ["package.json"],
            runner: reportWriterRunner({
                calls,
                lcov: ["LF:100", "LH:90"].join("\n"),
            }),
        });
        assert.equal(result.status, "pass");
        assert.match(result.notice ?? "", /90\.0%/u);
        assert.equal(scratch.dir, calls[0]!.at(-1));
    } finally {
        cleanupScratch(scratch);
    }
});

test("fix mode runs the consumer command", async () => {
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { node: { command: "npm run test:coverage" } },
        },
        reportPath: "coverage/lcov.info",
        reportContent: ["LF:100", "LH:90"].join("\n"),
    });
    const { calls } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        mode: "fix",
        trackedFiles: ["package.json"],
        runnerOutcomes: { sh: { status: 0 } },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], "sh");
    assert.equal(calls[0]![1], "-c");
    assert.equal(calls[0]![2], "npm run test:coverage");
});
