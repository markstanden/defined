// Tests for steps/dotnet-coverage.mts: Cobertura parser + minimum gate.
// Runner injected, so no host binaries are needed here.
// Run: node --test runtime/steps/dotnet-coverage.test.mts

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import type { CommandResult } from "../../lib/proc.mts";
import {
    checkMinimums,
    parseCobertura,
    runDotNetCoverageStep,
} from "./dotnet-coverage.mts";
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
 * the given Cobertura XML into `cwd` (the repo in fix mode, the scratch in
 * no-fix) and records every call.
 */
function reportWriterRunner({
    calls,
    xml,
    location,
}: {
    calls: string[][];
    xml: string;
    location: "coverage.cobertura.xml" | "TestResults/coverage.cobertura.xml";
}): typeof import("../../lib/proc.mts").run {
    return (async ({ cmd, args, cwd }) => {
        calls.push([cmd, ...args, cwd ?? ""]);
        if (cmd === "sh") {
            const target = join(cwd!, location);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, xml);
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

const SAMPLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="0.85" branch-rate="0.7" version="1.9" timestamp="1234" lines-covered="85" lines-valid="100" branches-covered="35" branches-valid="50">
  <sources><source>/src</source></sources>
  <packages>
    <package name="MyLib" line-rate="0.85" branch-rate="0.7" complexity="10">
      <classes>
        <class name="Foo" filename="Foo.cs" line-rate="0.85" branch-rate="0.7">
          <methods>
            <method name="Bar" signature="()" line-rate="1" branch-rate="1">
              <lines>
                <line number="1" hits="5"/>
              </lines>
            </method>
          </methods>
          <lines>
            <line number="1" hits="5"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

// --- parseCobertura ---

test("parseCobertura extracts line and branch rates", () => {
    // Act
    const summary = parseCobertura({ content: SAMPLE_XML });

    // Assert
    assert.equal(summary.lineRate, 0.85);
    assert.equal(summary.branchRate, 0.7);
});

test("parseCobertura handles integer-style rates", () => {
    // Arrange
    const xml = '<coverage line-rate="1" branch-rate="0.5"></coverage>';

    // Act
    const summary = parseCobertura({ content: xml });

    // Assert
    assert.equal(summary.lineRate, 1);
    assert.equal(summary.branchRate, 0.5);
});

test("parseCobertura returns zero when rates absent", () => {
    // Arrange
    const xml = "<coverage></coverage>";

    // Act
    const summary = parseCobertura({ content: xml });

    // Assert
    assert.equal(summary.lineRate, 0);
    assert.equal(summary.branchRate, undefined);
});

test("parseCobertura returns zero for empty content", () => {
    // Act
    const summary = parseCobertura({ content: "" });

    // Assert
    assert.equal(summary.lineRate, 0);
    assert.equal(summary.branchRate, undefined);
});

// --- checkMinimums ---

test("checkMinimums passes when above line minimum", () => {
    // Act
    const result = checkMinimums({
        summary: { lineRate: 0.9, branchRate: 0.8 },
        minimums: { line: 80 },
    });

    // Assert
    assert.equal(result.pass, true);
    assert.equal(result.failures.length, 0);
});

test("checkMinimums fails when below line minimum", () => {
    // Act
    const result = checkMinimums({
        summary: { lineRate: 0.7, branchRate: 0.8 },
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
        summary: { lineRate: 0.9, branchRate: 0.6 },
        minimums: { line: 80, branch: 70 },
    });

    // Assert
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /branch:.*60\.0%.*70%/u);
});

test("checkMinimums fails on missing branch data when branch minimum configured", () => {
    // Act
    const result = checkMinimums({
        summary: { lineRate: 0.9, branchRate: undefined },
        minimums: { line: 80, branch: 70 },
    });

    // Assert
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /no branch-rate data/u);
});

test("checkMinimums fails on function minimum (no function data in Cobertura)", () => {
    // Act
    const result = checkMinimums({
        summary: { lineRate: 0.9, branchRate: 0.8 },
        minimums: { line: 80, function: 70 },
    });

    // Assert
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /no function coverage/u);
});

test("checkMinimums reports multiple failures", () => {
    // Act
    const result = checkMinimums({
        summary: { lineRate: 0.5, branchRate: 0.5 },
        minimums: { line: 80, branch: 70 },
    });

    // Assert
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 2);
});

// --- runDotNetCoverageStep ---

test("skips when no coverage.dotnet in config", async () => {
    // Arrange
    const dir = await makeTempDir("quality-dc-");
    await setupCoverageRepo({ root: dir, config: { version: TEST_SHA } });

    // Act
    const { result, calls } = await runCoverageScenario({
        step: runDotNetCoverageStep,
        repoRoot: dir,
        trackedFiles: ["App.csproj"],
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("skips when no .defined.json exists", async () => {
    // Arrange
    const dir = await makeTempDir("quality-dc-");

    // Act
    const { result, calls } = await runCoverageScenario({
        step: runDotNetCoverageStep,
        repoRoot: dir,
        trackedFiles: ["App.csproj"],
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("skips when dotnet is disabled by .defined.json", async () => {
    // Arrange
    const dir = await makeTempDir("quality-dc-");
    await setupCoverageRepo({
        root: dir,
        config: { version: TEST_SHA, dotnet: { disable: true } },
    });

    // Act
    const { result, calls } = await runCoverageScenario({
        step: runDotNetCoverageStep,
        repoRoot: dir,
        trackedFiles: ["App.csproj"],
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("fails when the coverage command fails", async () => {
    // Arrange
    const dir = await makeTempDir("quality-dc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { dotnet: { command: "false" } },
        },
    });

    // Act
    const { result } = await runCoverageScenario({
        step: runDotNetCoverageStep,
        repoRoot: dir,
        scratchDir: dir,
        trackedFiles: ["App.csproj"],
        runnerOutcomes: { sh: { status: 1, stderr: "boom" } },
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /coverage command failed/u);
});

test("fails when the command writes no cobertura report", async () => {
    // Arrange
    const dir = await makeTempDir("quality-dc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { dotnet: { command: "echo ok" } },
        },
    });

    // Act
    const { result } = await runCoverageScenario({
        step: runDotNetCoverageStep,
        repoRoot: dir,
        scratchDir: dir,
        trackedFiles: ["App.csproj"],
        runnerOutcomes: { sh: { status: 0 } },
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /no coverage report/u);
});

test("repair skips coverage generation entirely (verification-only, #65)", async () => {
    // Arrange
    const dir = await makeTempDir("quality-dc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { dotnet: { command: "dotnet test" } },
        },
    });

    // Act
    const { result, calls } = await runCoverageScenario({
        step: runDotNetCoverageStep,
        repoRoot: dir,
        mode: "fix",
        trackedFiles: ["App.csproj"],
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.match(result.notice ?? "", /deferred to verification/u);
    assert.equal(calls.length, 0);
});

test("write-capable no-fix runs in the repo so the report survives (#65)", async () => {
    // Arrange
    const dir = await makeTempDir("quality-dc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { dotnet: { command: "dotnet test" } },
        },
        reportPath: "TestResults/coverage.cobertura.xml",
        reportContent:
            '<coverage line-rate="0.9" branch-rate="0.8"></coverage>',
    });

    // Act
    const { result } = await runCoverageScenario({
        step: runDotNetCoverageStep,
        repoRoot: dir,
        mode: "no-fix",
        repoWritable: true,
        trackedFiles: ["App.csproj"],
        runnerOutcomes: { sh: { status: 0 } },
    });

    // Assert
    // The report lives only in the repo; a discarded scratch would not find it.
    assert.equal(result.status, "pass");
    assert.match(result.notice ?? "", /90\.0%/u);
});

test("passes when coverage meets default 80% minimum", async () => {
    // Arrange
    for (const location of [
        "coverage.cobertura.xml",
        "TestResults/coverage.cobertura.xml",
    ] as const) {
        const dir = await makeTempDir("quality-dc-");
        await setupCoverageRepo({
            root: dir,
            config: {
                version: TEST_SHA,
                coverage: { dotnet: { command: "dotnet test" } },
            },
        });
        await writeFile(join(dir, "App.csproj"), "<Project/>");
        const calls: string[][] = [];
        const scratch = { dir: dir as string | null };

        // Act
        const result = await runDotNetCoverageStep({
            ctx: { mode: "no-fix", repoRoot: dir, scratch },
            trackedFiles: ["App.csproj"],
            runner: reportWriterRunner({
                calls,
                xml: SAMPLE_XML,
                location,
            }),
        });

        // Assert
        assert.equal(result.status, "pass", location);
        assert.match(result.notice ?? "", /85\.0%/, location);
    }
});

test("gates line coverage against the minimum", async () => {
    // Arrange
    const SCENARIOS = [
        {
            label: "below default 80% line",
            minimums: undefined,
            xml: '<coverage line-rate="0.5" branch-rate="0.5"></coverage>',
            re: /50\.0%.*80%/u,
            status: "fail",
        },
        {
            label: "meets custom 50% line",
            minimums: { line: 50 },
            xml: '<coverage line-rate="0.6" branch-rate="0.5"></coverage>',
            re: /60\.0%/u,
            status: "pass",
        },
    ] as const;
    for (const { label, minimums, xml, re, status } of SCENARIOS) {
        const config: Record<string, unknown> = {
            version: TEST_SHA,
            coverage: { dotnet: { command: "dotnet test" } },
        };
        if (minimums) {
            (
                config.coverage as { dotnet: { minimums?: unknown } }
            ).dotnet.minimums = minimums;
        }
        const dir = await makeTempDir("quality-dc-");
        await setupCoverageRepo({ root: dir, config });
        await writeFile(join(dir, "App.csproj"), "<Project/>");
        const calls: string[][] = [];
        const scratch = { dir: dir as string | null };

        // Act
        const result = await runDotNetCoverageStep({
            ctx: { mode: "no-fix", repoRoot: dir, scratch },
            trackedFiles: ["App.csproj"],
            runner: reportWriterRunner({
                calls,
                xml,
                location: "TestResults/coverage.cobertura.xml",
            }),
        });

        // Assert
        assert.equal(result.status, status, label);
        assert.match(result.notice ?? "", re, label);
    }
});

test("no-fix runs the coverage command in a scratch workspace, isolated from the repo", async () => {
    // Arrange
    const dir = await makeTempDir("quality-dc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { dotnet: { command: "dotnet test" } },
        },
        // A report in the repo must NOT satisfy the pass: no-fix runs the
        // command in the scratch (left empty by the fake) and reads the report
        // from there too, so the repo's report is invisible.
        reportPath: "coverage.cobertura.xml",
        reportContent: SAMPLE_XML,
    });
    await writeFile(join(dir, "App.csproj"), "<Project/>");
    const calls: string[][] = [];
    const scratch = { dir: null as string | null };
    try {
        // Arrange — the injected runner records each call and writes nothing.
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
        const result = await runDotNetCoverageStep({
            ctx: { mode: "no-fix", repoRoot: dir, scratch },
            trackedFiles: ["App.csproj"],
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
    const dir = await makeTempDir("quality-dc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { dotnet: { command: "dotnet test" } },
        },
    });
    await writeFile(join(dir, "App.csproj"), "<Project/>");
    const calls: string[][] = [];
    const scratch = { dir: null as string | null };
    try {
        // Act
        const result = await runDotNetCoverageStep({
            ctx: { mode: "no-fix", repoRoot: dir, scratch },
            trackedFiles: ["App.csproj"],
            runner: reportWriterRunner({
                calls,
                xml: SAMPLE_XML,
                location: "TestResults/coverage.cobertura.xml",
            }),
        });

        // Assert
        assert.equal(result.status, "pass");
        assert.match(result.notice ?? "", /85\.0%/u);
        assert.equal(scratch.dir, calls[0]!.at(-1));
    } finally {
        cleanupScratch(scratch);
    }
});

test("no-fix runs the consumer command once", async () => {
    // Arrange
    const dir = await makeTempDir("quality-dc-");
    await setupCoverageRepo({
        root: dir,
        config: {
            version: TEST_SHA,
            coverage: { dotnet: { command: "dotnet run coverage" } },
        },
        reportPath: "coverage.cobertura.xml",
        reportContent: SAMPLE_XML,
    });

    // Act
    const { calls } = await runCoverageScenario({
        step: runDotNetCoverageStep,
        repoRoot: dir,
        scratchDir: dir,
        trackedFiles: ["App.csproj"],
        runnerOutcomes: { sh: { status: 0 } },
    });

    // Assert
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], "sh");
    assert.equal(calls[0]![1], "-c");
    assert.equal(calls[0]![2], "dotnet run coverage");
});
