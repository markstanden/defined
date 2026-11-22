// Tests for steps/node-coverage.mts: lcov parser + minimum gate.
// Runner injected, so no host binaries are needed here.
// Run: node --test runtime/steps/node-coverage.test.mts

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import fc from "fast-check";

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
    return (async ({ cmd, args, cwd }) => {
        calls.push([cmd, ...args, cwd ?? ""]);
        if (cmd === "sh") {
            const target = join(cwd!, "coverage/lcov.info");
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, lcov);
        }
        return {
            status: 0,
            stdout: "",
            stderr: "",
            signal: null,
            timedOut: false,
            cancelled: false,
            truncated: false,
        } satisfies CommandResult;
    }) as typeof import("../../lib/proc.mts").run;
}

// --- parseLcov ---

test("parseLcov extracts line totals from lcov content", () => {
    // Arrange
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

    // Act
    const summary = parseLcov({ content });

    // Assert
    assert.equal(summary.linesFound, 3);
    assert.equal(summary.linesHit, 2);
    assert.equal(summary.branchesFound, 4);
    assert.equal(summary.branchesHit, 3);
    assert.equal(summary.functionsFound, 5);
    assert.equal(summary.functionsHit, 4);
});

test("parseLcov aggregates across multiple source files", () => {
    // Arrange
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

    // Act
    const summary = parseLcov({ content });

    // Assert
    assert.equal(summary.linesFound, 5);
    assert.equal(summary.linesHit, 4);
    assert.equal(summary.branchesFound, 6);
    assert.equal(summary.branchesHit, 5);
    assert.equal(summary.functionsFound, 5);
    assert.equal(summary.functionsHit, 4);
});

test("parseLcov returns zeros for empty content", () => {
    // Act
    const summary = parseLcov({ content: "" });

    // Assert
    assert.equal(summary.linesFound, 0);
    assert.equal(summary.linesHit, 0);
    assert.equal(summary.branchesFound, 0);
    assert.equal(summary.branchesHit, 0);
    assert.equal(summary.functionsFound, 0);
    assert.equal(summary.functionsHit, 0);
});

test("parseLcov rejects a malformed hit counter (the reported reproduction)", () => {
    // Act & Assert
    assert.throws(
        () => parseLcov({ content: "LF:10\nLH:garbage\n" }),
        /LH counter 'garbage' is not a non-negative integer/u,
    );
});

test("parseLcov rejects negative, fractional and infinite counters", () => {
    // Arrange
    for (const bad of ["-1", "1.5", "Infinity", "NaN", "0x10", ""]) {
        // Act & Assert
        assert.throws(
            () => parseLcov({ content: `LF:10\nLH:${bad}\n` }),
            /is not a non-negative integer/u,
            `LH:${bad} must be rejected`,
        );
    }
});

test("parseLcov rejects a hit count exceeding found in any record", () => {
    // Act & Assert
    assert.throws(
        () => parseLcov({ content: "LF:10\nLH:11\n" }),
        /line hit count 11 exceeds found count 10/u,
    );

    // Arrange
    // Aggregate is 15/15 (valid), but the second record alone is inconsistent —
    // per-record validation must not let the total hide it.
    const content = [
        "LF:10",
        "LH:10",
        "end_of_record",
        "LF:5",
        "LH:6",
        "end_of_record",
    ].join("\n");

    // Act & Assert
    assert.throws(
        () => parseLcov({ content }),
        /line hit count 6 exceeds found count 5/u,
    );
});

test("parseLcov rejects a malformed branch counter", () => {
    // Act & Assert
    assert.throws(
        () => parseLcov({ content: "BRF:4\nBRH:oops\n" }),
        /BRH counter 'oops'/u,
    );
});

test("parseLcov rejects a malformed function counter", () => {
    // Act & Assert
    assert.throws(
        () => parseLcov({ content: "FNF:2\nFNH:-3\n" }),
        /FNH counter '-3'/u,
    );
});

// --- checkMinimums ---

test("checkMinimums passes when above minimum", () => {
    // Act
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

    // Assert
    assert.equal(result.pass, true);
    assert.equal(result.failures.length, 0);
});

test("checkMinimums fails when below minimum", () => {
    // Act
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

    // Assert
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /line:.*70\.0%.*80%/u);
});

test("checkMinimums checks branch when configured", () => {
    // Act
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

    // Assert
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /branch:.*60\.0%.*70%/u);
});

test("checkMinimums checks function when configured", () => {
    // Act
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

    // Assert
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /function:.*50\.0%.*70%/u);
});

test("checkMinimums reports multiple failures", () => {
    // Act
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

    // Assert
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 3);
});

test("checkMinimums reports the exact counter pair with a floored percentage", () => {
    // 724/2500 lines is 28.96%; a rounded one-decimal percentage printed
    // "29.0% < 29%", contradicting the verdict.
    // Arrange
    const summary = {
        linesFound: 2500,
        linesHit: 724,
        branchesFound: 0,
        branchesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
    };

    // Act
    const result = checkMinimums({ summary, minimums: { line: 29 } });

    // Assert
    assert.deepEqual(result.failures, [
        "line: 28.96% (724/2500) < 29% minimum",
    ]);
});

test("a failure message never rounds its percentage up to the minimum", () => {
    // 899,999 of 1,000,000 lines is 89.9999%; rounding to four decimal places
    // would read 90.0000 and contradict the verdict.
    // Arrange
    const summary = {
        linesFound: 1_000_000,
        linesHit: 899_999,
        branchesFound: 0,
        branchesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
    };

    // Act
    const result = checkMinimums({ summary, minimums: { line: 90 } });

    // Assert
    assert.deepEqual(result.failures, [
        "line: 89.9999% (899999/1000000) < 90% minimum",
    ]);
});

test("checkMinimums treats zero lines found as 0%", () => {
    // Act
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

    // Assert
    assert.equal(result.pass, false);
});

test("checkMinimums rejects a non-finite summary instead of passing it", () => {
    // Act
    const result = checkMinimums({
        summary: {
            linesFound: 10,
            linesHit: Number.NaN,
            branchesFound: 0,
            branchesHit: 0,
            functionsFound: 0,
            functionsHit: 0,
        },
        minimums: { line: 80 },
    });

    // Assert
    assert.equal(result.pass, false);
    assert.match(result.failures[0]!, /invalid counters/u);
});

test("checkMinimums rejects a negative found count", () => {
    // Act & Assert
    assert.equal(
        checkMinimums({
            summary: {
                linesFound: -1,
                linesHit: 5,
                branchesFound: 0,
                branchesHit: 0,
                functionsFound: 0,
                functionsHit: 0,
            },
            minimums: { line: 80 },
        }).pass,
        false,
    );
});

test("checkMinimums rejects a hit count exceeding found", () => {
    // Act & Assert
    assert.equal(
        checkMinimums({
            summary: {
                linesFound: 10,
                linesHit: 11,
                branchesFound: 0,
                branchesHit: 0,
                functionsFound: 0,
                functionsHit: 0,
            },
            minimums: { line: 80 },
        }).pass,
        false,
    );
});

test("checkMinimums passes when coverage exactly meets the minimum", () => {
    // Regression: 29 of 100 lines at a 29% minimum computed 28.999999999999996
    // in floating point and failed, printing "29.0% < 29% minimum". Shrunk
    // from the property below, which found it before the fix.
    // Arrange
    const summary = {
        linesFound: 100,
        linesHit: 29,
        branchesFound: 0,
        branchesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
    };

    // Act
    const result = checkMinimums({ summary, minimums: { line: 29 } });

    // Assert
    assert.equal(result.pass, true);
    assert.deepEqual(result.failures, []);
});

test("checkMinimums agrees with the exact ratio at every boundary", () => {
    // Contract: a metric passes iff hit/found >= minimum/100. With integer
    // counters and minimums the exact form is hit*100 >= minimum*found; the
    // float form (hit/found)*100 >= minimum can round below the boundary.
    // Coverage totals are round (lines and branches are counted in hundreds),
    // so the generator puts hit exactly on the documented threshold — the
    // boundary is where the contract decides, and where a borrowed float
    // comparison drifts. It must stay an integer counter: the contract rejects
    // fractional counts as malformed before any comparison.
    // Arrange
    const ROUND_DENOMINATORS = [100, 200, 400, 500, 1000, 2000];
    const boundaryCounters = fc.integer({ min: 0, max: 100 }).chain((minimum) =>
        fc.constantFrom(...ROUND_DENOMINATORS).map((found) => ({
            found,
            minimum,
            hit: (minimum * found) / 100,
        })),
    );

    // Act & Assert
    fc.assert(
        fc.property(boundaryCounters, ({ found, hit, minimum }) => {
            // Act
            const result = checkMinimums({
                summary: {
                    linesFound: found,
                    linesHit: hit,
                    branchesFound: 0,
                    branchesHit: 0,
                    functionsFound: 0,
                    functionsHit: 0,
                },
                minimums: { line: minimum },
            });

            // Assert
            return result.pass === hit * 100 >= minimum * found;
        }),
        { seed: 20261122, numRuns: 500 },
    );
});

test("a failure message never displays the minimum it failed", () => {
    // Contract: the message must not contradict the verdict. The displayed
    // percentage is floored, so a failing case always reads below its minimum,
    // however small the exact shortfall.
    // Arrange
    const ROUND_DENOMINATORS = [100, 200, 400, 500, 1000, 2000];
    const failingCounters = fc.integer({ min: 1, max: 100 }).chain((minimum) =>
        fc.constantFrom(...ROUND_DENOMINATORS).map((found) => ({
            found,
            minimum,
            hit: Math.max(0, Math.floor((minimum * found) / 100) - 1),
        })),
    );

    // Act & Assert
    fc.assert(
        fc.property(failingCounters, ({ found, hit, minimum }) => {
            // Act
            const result = checkMinimums({
                summary: {
                    linesFound: found,
                    linesHit: hit,
                    branchesFound: 0,
                    branchesHit: 0,
                    functionsFound: 0,
                    functionsHit: 0,
                },
                minimums: { line: minimum },
            });

            // Assert
            const shown = Number(
                /^line: ([\d.]+)%/u.exec(result.failures[0] ?? "")?.[1],
            );
            return result.pass === false && shown < minimum;
        }),
        { seed: 20261130 },
    );
});

// --- runNodeCoverageStep ---

test("skips when no coverage.node in config", async () => {
    // Arrange
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({ root: dir, config: { version: TEST_SHA } });

    // Act
    const { result, calls } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        trackedFiles: ["package.json"],
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("skips when no .defined.json exists", async () => {
    // Arrange
    const dir = await makeTempDir("quality-nc-");

    // Act
    const { result, calls } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        trackedFiles: ["package.json"],
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("fails when the coverage command fails", async () => {
    // Arrange
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({
        root: dir,
        config: { version: TEST_SHA, coverage: { node: { command: "false" } } },
    });

    // Act
    const { result } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        scratchDir: dir,
        trackedFiles: ["package.json"],
        runnerOutcomes: { sh: { status: 1, stderr: "boom" } },
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /coverage command failed/u);
});

test("fails when the command writes no lcov.info", async () => {
    // Arrange
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { node: { command: "echo ok" } },
        },
    });

    // Act
    const { result } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        scratchDir: dir,
        trackedFiles: ["package.json"],
        runnerOutcomes: { sh: { status: 0 } },
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /no coverage report/u);
});

test("repair skips coverage generation entirely (verification-only, #65)", async () => {
    // Arrange
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { node: { command: "npm t" } },
        },
        reportPath: "coverage/lcov.info",
        reportContent: ["LF:100", "LH:90"].join("\n"),
    });

    // Act
    const { result, calls } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        mode: "fix",
        trackedFiles: ["package.json"],
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.match(result.notice ?? "", /deferred to verification/u);
    assert.equal(calls.length, 0);
});

test("write-capable no-fix runs in the repo so the report survives (#65)", async () => {
    // Arrange
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { node: { command: "npm t" } },
        },
        reportPath: "coverage/lcov.info",
        reportContent: ["LF:100", "LH:90"].join("\n"),
    });

    // Act
    const { result } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        mode: "no-fix",
        repoWritable: true,
        trackedFiles: ["package.json"],
        runnerOutcomes: { sh: { status: 0 } },
    });

    // Assert
    // The report lives only in the repo; a discarded scratch would not find it.
    assert.equal(result.status, "pass");
    assert.match(result.notice ?? "", /90\.0%/u);
});

test("gates line coverage against the effective minimum", async () => {
    // Arrange
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
            scratchDir: dir,
            trackedFiles: ["package.json"],
        });

        // Act & Assert
        assert.equal(result.status, status, label);
        assert.match(result.notice ?? "", re, label);
    }
});

test("no-fix runs the coverage command in a scratch workspace, isolated from the repo", async () => {
    // Arrange
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
        const runner = (async ({ cmd, args, cwd }) => {
            calls.push([cmd, ...args, cwd ?? ""]);
            return {
                status: 0,
                stdout: "",
                stderr: "",
                signal: null,
                timedOut: false,
                cancelled: false,
                truncated: false,
            } satisfies CommandResult;
        }) as typeof import("../../lib/proc.mts").run;
        // Act
        const result = await runNodeCoverageStep({
            ctx: { mode: "no-fix", repoRoot: dir, scratch },
            trackedFiles: ["package.json"],
            runner,
        });

        // Assert
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
    // Arrange
    const dir = await makeTempDir("quality-nc-");
    await setupCoverageRepo({
        root: dir,
        config: { version: TEST_SHA, coverage: { node: { command: "npm t" } } },
    });
    await writeFile(join(dir, "package.json"), "{}");
    const calls: string[][] = [];
    const scratch = { dir: null as string | null };
    try {
        // Act
        const result = await runNodeCoverageStep({
            ctx: { mode: "no-fix", repoRoot: dir, scratch },
            trackedFiles: ["package.json"],
            runner: reportWriterRunner({
                calls,
                lcov: ["LF:100", "LH:90"].join("\n"),
            }),
        });

        // Assert
        assert.equal(result.status, "pass");
        assert.match(result.notice ?? "", /90\.0%/u);
        assert.equal(scratch.dir, calls[0]!.at(-1));
    } finally {
        cleanupScratch(scratch);
    }
});

test("reports a malformed lcov report as an execution error", async () => {
    // Arrange
    const dir = await makeTempDir("quality-nc-bad-");
    await setupCoverageRepo({
        root: dir,
        config: { version: TEST_SHA, coverage: { node: { command: "npm t" } } },
        reportPath: "coverage/lcov.info",
        reportContent: "LF:10\nLH:garbage\n",
    });

    // Act
    const { result } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        scratchDir: dir,
        trackedFiles: ["package.json"],
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /invalid lcov report/u);
});

test("no-fix runs the consumer command once", async () => {
    // Arrange
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

    // Act
    const { calls } = await runCoverageScenario({
        step: runNodeCoverageStep,
        repoRoot: dir,
        scratchDir: dir,
        trackedFiles: ["package.json"],
        runnerOutcomes: { sh: { status: 0 } },
    });

    // Assert
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], "sh");
    assert.equal(calls[0]![1], "-c");
    assert.equal(calls[0]![2], "npm run test:coverage");
});
