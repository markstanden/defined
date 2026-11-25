// Tests for comply.mts: the orchestrator's pass loop, two-verb flows and exit
// contract. The heavy tool/setup logic lives in the step modules and
// setup.mts, each tested separately — here we drive the wiring with fakes.
// Run: node --test runtime/comply.test.mts

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
    acquireComplyLock,
    cancellableRunner,
    CONSUMER_RESOURCE,
    DEFAULT_CONCURRENCY,
    printUsage,
    resolveConcurrency,
    runExplain,
    runGate,
    runPass,
    runSmoke,
    SCOPED_STEP_IDS,
    settleExit,
    STEP_IDS,
} from "./comply.mts";
import { STEP_IDS as EXPLAIN_STEP_IDS } from "./lib/explain.mts";
import type { AcquireLockResult, LockInfo } from "./lib/lock.mts";
import { failed, passed, type StepResult } from "./lib/step-result.mts";
import type { GateResult } from "./lib/report.mts";
import type { Timings } from "./lib/timings.mts";
import type { SetupCheck } from "./setup.mts";
import type { CommandResult } from "../lib/proc.mts";

type PassResult = Map<string, StepResult>;

function fakeStep(
    id: string,
    result: StepResult,
): { id: string; run: () => Promise<StepResult> } {
    return { id, run: async () => result };
}

function cleanSetup(): SetupCheck {
    return {
        files: [
            { name: ".editorconfig", status: "present" },
            { name: "Directory.Build.props", status: "present" },
        ],
        agents: "present",
        drift: [],
    };
}

function allGreen(): PassResult {
    return new Map([
        ["node", passed({ notice: "ok" })],
        ["shell", passed({})],
    ]);
}

function oneFail(): PassResult {
    return new Map([
        ["node", passed({})],
        ["workflow", failed({ notice: "actionlint failed" })],
    ]);
}

/** Parse the single JSON line the gate is contracted to print. */
function parsePrinted(printed: string[]): GateResult {
    assert.equal(printed.length, 1, "exactly one JSON line on stdout");
    return JSON.parse(printed[0]!) as GateResult;
}

test("runPass initialises then records every step in order", async () => {
    // Act
    const results = await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        steps: [fakeStep("node", passed({})), fakeStep("shell", failed({}))],
    });

    // Assert
    assert.deepEqual(
        [...results].map(([id, r]) => [id, r.status]),
        [
            ["node", "pass"],
            ["shell", "fail"],
        ],
    );
});

test("runPass forwards the mode to each step", async () => {
    // Arrange
    const modes: string[] = [];

    // Act
    const results = await runPass({
        mode: "fix",
        repoRoot: "/repo",
        files: [],
        steps: [
            {
                id: "probe",
                run: async ({ mode }) => {
                    modes.push(mode);
                    return passed({});
                },
            },
        ],
    });

    // Assert
    assert.deepEqual(modes, ["fix"]);
    assert.equal(results.get("probe")?.status, "pass");
});

test("runPass_recordsAThrownStepAsAnErrorAndContinues", async () => {
    // Act
    const results = await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        steps: [
            {
                id: "broken",
                run: async () => {
                    throw new Error("cannot run 'tool': not found");
                },
            },
            fakeStep("after", passed({})),
        ],
    });

    // Assert
    assert.equal(results.get("broken")?.status, "error");
    assert.deepEqual(results.get("broken")?.errors, [
        { kind: "execution", message: "cannot run 'tool': not found" },
    ]);
    assert.equal(results.get("after")?.status, "pass");
});

test("runPass_withTimings_recordsEachStepUnderItsMode", async () => {
    // Arrange
    const labels: string[] = [];
    const timings: Timings = { record: (label) => labels.push(label) };

    // Act
    await runPass({
        mode: "fix",
        repoRoot: "/repo",
        files: [],
        timings,
        steps: [fakeStep("node", passed({})), fakeStep("shell", passed({}))],
    });

    // Assert
    assert.deepEqual(labels, ["fix/node", "fix/shell"]);
});

test("runGate_complyGreen_printsOneCompliantResultAndDoesNotExit", async () => {
    // Arrange
    const printed: string[] = [];
    const exits: number[] = [];

    // Act
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: [],
        presentation: "full",
        deps: {
            runSetupFn: async () => undefined,
            checkSetupFn: async () => cleanSetup(),
            trackedFilesFn: async () => [],
            runPassFn: async () => allGreen(),
            printFn: (line) => printed.push(line),
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert
    const result = parsePrinted(printed);
    assert.equal(result.status, "compliant");
    assert.deepEqual(result.results, {
        bootstrap: "pass",
        node: "pass",
        shell: "pass",
    });
    assert.equal("errors" in result, false, "success omits the errors key");
    assert.deepEqual(exits, [], "green comply must not exit non-zero");
});

test("runGate_complyFindingSurvivesRepair_reportsFindingAndExits", async () => {
    // Arrange
    const printed: string[] = [];
    const exits: number[] = [];

    // Act
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: [],
        presentation: "full",
        deps: {
            runSetupFn: async () => undefined,
            checkSetupFn: async () => cleanSetup(),
            trackedFilesFn: async () => [],
            runPassFn: async () => oneFail(),
            printFn: (line) => printed.push(line),
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert
    const result = parsePrinted(printed);
    assert.equal(result.status, "not_compliant");
    assert.equal(result.results.workflow, "fail");
    assert.deepEqual(result.errors, [
        { check: "workflow", kind: "finding", message: "actionlint failed" },
    ]);
    assert.deepEqual(exits, [1]);
});

test("runGate_complyBootstrapDrift_reportsItThroughTheCanonicalResult", async () => {
    // Arrange
    const printed: string[] = [];
    const exits: number[] = [];

    // Act
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: [],
        presentation: "full",
        deps: {
            runSetupFn: async () => undefined,
            checkSetupFn: async () => ({
                files: [
                    { name: ".editorconfig", status: "drift" },
                    { name: "Directory.Build.props", status: "present" },
                ],
                agents: "present",
            }),
            trackedFilesFn: async () => [],
            runPassFn: async () => allGreen(),
            printFn: (line) => printed.push(line),
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert
    const result = parsePrinted(printed);
    assert.equal(result.results.bootstrap, "fail");
    assert.deepEqual(result.errors, [
        {
            check: "bootstrap",
            kind: "finding",
            message: ".editorconfig: differs from gate copy",
            file: ".editorconfig",
        },
    ]);
    assert.deepEqual(exits, [1]);
});

test("runGate_comply_reFetchesTrackedFilesAfterBootstrap", async () => {
    // Arrange
    const passedFiles: string[][] = [];

    // Act
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: ["pre-setup.txt"],
        deps: {
            runSetupFn: async () => undefined,
            checkSetupFn: async () => cleanSetup(),
            trackedFilesFn: async () => ["post-setup.txt"],
            runPassFn: async ({ files }) => {
                passedFiles.push(files);
                return allGreen();
            },
            printFn: () => undefined,
            exitFn: () => undefined,
        },
    });

    // Assert
    // Both passes see the post-bootstrap snapshot, never the pre-setup one.
    assert.deepEqual(passedFiles, [["post-setup.txt"], ["post-setup.txt"]]);
});

test("runGate_comply_reFetchesTrackedFilesAfterRepair", async () => {
    // Arrange
    const verifyFiles: string[][] = [];
    let fetches = 0;
    const passes: string[] = [];

    // Act
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: [],
        deps: {
            runSetupFn: async () => undefined,
            checkSetupFn: async () => cleanSetup(),
            trackedFilesFn: async () => {
                fetches += 1;
                return [fetches === 1 ? "after-setup.txt" : "after-repair.txt"];
            },
            runPassFn: async ({ mode, files }) => {
                passes.push(mode);
                if (mode === "no-fix") {
                    verifyFiles.push(files);
                }
                return allGreen();
            },
            printFn: () => undefined,
            exitFn: () => undefined,
        },
    });

    // Assert
    // The repair pass sees the post-setup snapshot; verification re-fetches
    // after repairs so a file created by a fixer is checked (#62).
    assert.deepEqual(passes, ["fix", "no-fix"]);
    assert.deepEqual(verifyFiles, [["after-repair.txt"]]);
    assert.equal(fetches, 2, "setup refresh + a fresh fetch after repair");
});

test("runGate_comply_marksBothPassesRepoWritable", async () => {
    // Arrange
    const flags: Array<boolean | undefined> = [];

    // Act
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: [],
        deps: {
            runSetupFn: async () => undefined,
            checkSetupFn: async () => cleanSetup(),
            trackedFilesFn: async () => [],
            runPassFn: async ({ repoWritable }) => {
                flags.push(repoWritable);
                return allGreen();
            },
            printFn: () => undefined,
            exitFn: () => undefined,
        },
    });

    // Assert
    // Comply is write-capable: both passes run report steps in the repo, so the
    // coverage artifact a scanner reads survives the run (#65).
    assert.deepEqual(flags, [true, true]);
});

test("runGate_verify_leavesPassesReadOnly", async () => {
    // Arrange
    const flags: Array<boolean | undefined> = [];

    // Act
    await runGate({
        verb: "verify",
        repoRoot: "/repo",
        files: [],
        deps: {
            checkSetupFn: async () => cleanSetup(),
            runPassFn: async ({ repoWritable }) => {
                flags.push(repoWritable);
                return allGreen();
            },
            printFn: () => undefined,
            exitFn: () => undefined,
        },
    });

    // Assert
    // A read-only verify never opts into writing the repo mount.
    assert.deepEqual(flags, [undefined]);
});

test("runGate_comply_reRenameLeavesNoStaleVerificationPath", async () => {
    // Arrange
    const verifyFiles: string[][] = [];
    const snapshots = [
        ["Old.cs", "Keep.cs"],
        ["New.cs", "Keep.cs"],
    ];

    // Act
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: [],
        deps: {
            runSetupFn: async () => undefined,
            checkSetupFn: async () => cleanSetup(),
            // A repair renamed Old.cs to New.cs: the second fetch reflects it.
            trackedFilesFn: async () => snapshots.shift() ?? [],
            runPassFn: async ({ mode, files }) => {
                if (mode === "no-fix") {
                    verifyFiles.push(files);
                }
                return allGreen();
            },
            printFn: () => undefined,
            exitFn: () => undefined,
        },
    });

    // Assert
    // Verification judges the post-repair tree: it sees the new name and never
    // the stale one, which the no-fix scratch copy would fail to find (#62).
    assert.deepEqual(verifyFiles, [["New.cs", "Keep.cs"]]);
    assert.equal(verifyFiles[0]!.includes("Old.cs"), false);
});

test("runGate_verify_checksSetupThenRunsTheNoFixPass", async () => {
    // Arrange
    const printed: string[] = [];
    const exits: number[] = [];
    const calls: string[] = [];

    // Act
    await runGate({
        verb: "verify",
        repoRoot: "/repo",
        files: [],
        deps: {
            checkSetupFn: async ({ startDir }) => {
                calls.push(`setup:${startDir}`);
                return cleanSetup();
            },
            runPassFn: async ({ mode }) => {
                calls.push(`pass:${mode}`);
                return allGreen();
            },
            printFn: (line) => printed.push(line),
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert — setup first, then exactly one no-fix pass.
    assert.deepEqual(calls, ["setup:/repo", "pass:no-fix"]);
    assert.equal(parsePrinted(printed).status, "compliant");
    assert.deepEqual(exits, []);
});

test("runGate_verifyFailingStep_exitsOne", async () => {
    // Arrange
    const exits: number[] = [];

    // Act
    await runGate({
        verb: "verify",
        repoRoot: "/repo",
        files: [],
        deps: {
            checkSetupFn: async () => cleanSetup(),
            runPassFn: async () => oneFail(),
            printFn: () => undefined,
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert
    assert.deepEqual(exits, [1]);
});

test("runGate_scan_skipsTheBootstrapCheckAndRunsTheNoFixPass", async () => {
    // Arrange
    const printed: string[] = [];
    const exits: number[] = [];
    const calls: string[] = [];

    // Act
    await runGate({
        verb: "scan",
        repoRoot: "/repo",
        files: ["a.ts"],
        presentation: "full",
        deps: {
            checkSetupFn: async () => {
                calls.push("setup");
                return cleanSetup();
            },
            runPassFn: async ({ mode, files }) => {
                calls.push(`pass:${mode}`);
                assert.deepEqual(files, ["a.ts"]);
                return allGreen();
            },
            printFn: (line) => printed.push(line),
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert — no bootstrap check at all, then exactly one no-fix pass.
    assert.deepEqual(calls, ["pass:no-fix"]);
    const result = parsePrinted(printed);
    assert.equal(result.status, "compliant");
    assert.equal(result.results.bootstrap, "skip");
    assert.equal("errors" in result, false, "a clean scan has no diagnostics");
    assert.deepEqual(exits, []);
});

test("runGate_scanFailingStep_exitsOne", async () => {
    // Arrange
    const exits: number[] = [];

    // Act
    await runGate({
        verb: "scan",
        repoRoot: "/repo",
        files: [],
        deps: {
            checkSetupFn: async () => cleanSetup(),
            runPassFn: async () => oneFail(),
            printFn: () => undefined,
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert
    assert.deepEqual(exits, [1]);
});

test("runGate_defaultsToMinPresentation", async () => {
    // Arrange
    const printed: string[] = [];

    // Act
    await runGate({
        verb: "verify",
        repoRoot: "/repo",
        files: [],
        deps: {
            checkSetupFn: async () => cleanSetup(),
            runPassFn: async () => allGreen(),
            printFn: (line) => printed.push(line),
            exitFn: () => undefined,
        },
    });

    // Assert
    // The default is min: no results map, just the verdict.
    assert.deepEqual(printed, ['{"status":"compliant"}']);
});

test("runGate_minGreen_printsOnlyTheStatus", async () => {
    // Arrange
    const printed: string[] = [];

    // Act
    await runGate({
        verb: "verify",
        repoRoot: "/repo",
        files: [],
        presentation: "min",
        deps: {
            checkSetupFn: async () => cleanSetup(),
            runPassFn: async () => allGreen(),
            printFn: (line) => printed.push(line),
            exitFn: () => undefined,
        },
    });

    // Assert
    assert.deepEqual(printed, ['{"status":"compliant"}']);
});

test("runGate_minFailure_keepsDiagnosticsButDropsResults", async () => {
    // Arrange
    const printed: string[] = [];

    // Act
    await runGate({
        verb: "verify",
        repoRoot: "/repo",
        files: [],
        presentation: "min",
        deps: {
            checkSetupFn: async () => cleanSetup(),
            runPassFn: async () => oneFail(),
            printFn: (line) => printed.push(line),
            exitFn: () => undefined,
        },
    });

    // Assert
    const result = JSON.parse(printed[0]!);
    assert.equal(result.status, "not_compliant");
    assert.equal("results" in result, false);
    assert.deepEqual(result.errors, [
        { check: "workflow", kind: "finding", message: "actionlint failed" },
    ]);
});

test("runGate_timings_writesDurationsToStderrAndLeavesStdoutAlone", async () => {
    // Arrange
    const printed: string[] = [];
    const notified: string[] = [];

    // Act
    await runGate({
        verb: "verify",
        repoRoot: "/repo",
        files: [],
        timings: true,
        deps: {
            checkSetupFn: async () => cleanSetup(),
            runPassFn: async () => allGreen(),
            printFn: (line) => printed.push(line),
            notifyFn: (line) => notified.push(line),
            exitFn: () => undefined,
        },
    });

    // Assert
    // stdout is still exactly the one JSON result line.
    assert.deepEqual(printed, ['{"status":"compliant"}']);
    for (const line of notified) {
        assert.match(line, /^defined: timing .+ \d+ms$/u);
    }
    const labels = notified.map((line) =>
        line.replace(/^defined: timing /u, "").replace(/ \d+ms$/u, ""),
    );
    assert.deepEqual(labels, ["setup check", "no-fix pass", "verify total"]);
});

test("runGate_withoutTimings_writesNoTimingLines", async () => {
    // Arrange
    const notified: string[] = [];

    // Act
    await runGate({
        verb: "verify",
        repoRoot: "/repo",
        files: [],
        deps: {
            checkSetupFn: async () => cleanSetup(),
            runPassFn: async () => allGreen(),
            printFn: () => undefined,
            notifyFn: (line) => notified.push(line),
            exitFn: () => undefined,
        },
    });

    // Assert
    assert.deepEqual(notified, []);
});

test("runGate threads the cache dir into the no-fix pass", async () => {
    // Arrange
    const captured: { cacheDir?: string }[] = [];

    // Act
    await runGate({
        verb: "verify",
        repoRoot: "/repo",
        files: [],
        deps: {
            cacheDir: "/caches/defined",
            checkSetupFn: async () => cleanSetup(),
            runPassFn: async ({ cacheDir }) => {
                captured.push({ cacheDir });
                return allGreen();
            },
            printFn: () => undefined,
            exitFn: () => undefined,
        },
    });

    // Assert
    assert.deepEqual(captured, [{ cacheDir: "/caches/defined" }]);
});

test("runGate passes the notify sink only under --timings", async () => {
    // Arrange
    const runVerifyWith = async (timings: boolean): Promise<boolean> => {
        let received: ((line: string) => void) | undefined;
        await runGate({
            verb: "verify",
            repoRoot: "/repo",
            files: [],
            timings,
            deps: {
                checkSetupFn: async () => cleanSetup(),
                runPassFn: async ({ notify }) => {
                    received = notify;
                    return allGreen();
                },
                printFn: () => undefined,
                notifyFn: () => undefined,
                exitFn: () => undefined,
            },
        });
        return received !== undefined;
    };

    // Act & Assert
    // Without --timings the cache metrics must stay silent: no notify to steps.
    assert.equal(await runVerifyWith(false), false);
    // With --timings the sink reaches the steps.
    assert.equal(await runVerifyWith(true), true);
});

test("runExplain_printsOneJsonObjectAndDoesNotExit", async () => {
    // Arrange
    const printed: string[] = [];
    const exits: number[] = [];

    // Act
    await runExplain({
        topic: "shell",
        repoRoot: "/repo",
        deps: {
            explainFn: async ({ topic }) => ({
                topic,
                kind: "step",
                owner: { side: "house", detail: "x" },
                doc: null,
                guidance: null,
                notice: "n",
            }),
            printFn: (line) => printed.push(line),
            errorFn: () => undefined,
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert
    assert.equal(printed.length, 1, "exactly one JSON line on stdout");
    assert.equal(JSON.parse(printed[0]!).topic, "shell");
    assert.deepEqual(exits, []);
});

test("runExplain_unknownTopic_reportsToStderrAndExitsTwo", async () => {
    // Arrange
    const errors: string[] = [];
    const exits: number[] = [];

    // Act
    await runExplain({
        topic: "wat",
        repoRoot: "/repo",
        deps: {
            explainFn: async () => {
                throw new Error("unknown topic 'wat'");
            },
            printFn: () => undefined,
            errorFn: (line) => errors.push(line),
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert
    assert.match(errors[0]!, /unknown topic 'wat'/u);
    assert.deepEqual(exits, [2]);
});

test("explainStepIds_coverEveryOrchestratorStep", () => {
    // Act & Assert — the filter and its comparison are one statement.
    assert.deepEqual(
        EXPLAIN_STEP_IDS.filter((id) => id !== "bootstrap"),
        STEP_IDS,
    );
});

test("printUsage prints the result-verb usage line with flags", () => {
    // Arrange
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
        // Act
        printUsage();
    } finally {
        console.log = original;
    }

    // Assert
    assert.deepEqual(lines, [
        "usage: defined comply [--min|--full] [--timings] | defined verify [--min|--full] [--timings] | defined scan [--files <paths…>] [--min|--full] [--timings] | defined explain <step-or-rule>",
    ]);
});

test("runSmoke probes /usr/bin/git in the container", async () => {
    // Act
    const result = await runSmoke({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
    });

    // Assert
    assert.equal(result.status, "pass");
});

// #70 — bounded concurrency, deterministic reports, resources and cancellation.

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

/** Yield enough microtasks for the scheduler to launch and settle work. */
async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
    }
}

test("runPass_noFix_overlapsIndependentSteps", async () => {
    // Arrange
    const a = deferred<void>();
    const b = deferred<void>();
    const started: string[] = [];
    const step = (id: string, gate: { promise: Promise<void> }) => ({
        id,
        run: async () => {
            started.push(id);
            await gate.promise;
            return passed({});
        },
    });

    // Act
    const pass = runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        steps: [step("a", a), step("b", b)],
        concurrency: 2,
    });

    // Assert
    assert.deepEqual(
        [...started].sort(),
        ["a", "b"],
        "independent steps run together",
    );
    a.resolve();
    b.resolve();
    await pass;
});

test("runPass_noFix_serialisesStepsSharingAResource", async () => {
    // Arrange
    let active = 0;
    let peak = 0;
    const step = (id: string) => ({
        id,
        uses: [CONSUMER_RESOURCE],
        run: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await flushMicrotasks();
            active -= 1;
            return passed({});
        },
    });

    // Act
    await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        steps: [step("a"), step("b"), step("c")],
        concurrency: 4,
    });

    // Assert
    assert.equal(peak, 1, "resource holders never overlap");
});

test("runPass_noFix_neverExceedsTheConcurrencyBound", async () => {
    // Arrange
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const steps = ["a", "b", "c", "d", "e"].map((id) => ({
        id,
        run: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise<void>((resolve) => releases.push(resolve));
            active -= 1;
            return passed({});
        },
    }));

    // Act
    const pass = runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        steps,
        concurrency: 2,
    });

    // Assert
    assert.equal(active, 2, "two steps start at the bound");
    // Act & Assert — free one slot at a time and check the bound holds.
    for (let i = 0; i < steps.length; i += 1) {
        assert.ok(active <= 2, `active ${active} exceeded the bound`);
        releases.shift()?.();
        await flushMicrotasks();
    }

    // Assert
    const results = await pass;
    assert.equal(peak, 2);
    assert.equal(
        [...results.values()].every((r) => r.status === "pass"),
        true,
    );
});

test("runPass_noFix_blocksDependentsOfAFailedPrerequisite", async () => {
    // Arrange
    let dependentRan = false;

    // Act
    const results = await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        steps: [
            {
                id: "node-deps",
                run: async () => failed({ notice: "install failed" }),
            },
            {
                id: "node",
                needs: ["node-deps"],
                run: async () => {
                    dependentRan = true;
                    return passed({});
                },
            },
        ],
    });

    // Assert
    assert.equal(results.get("node-deps")?.status, "fail");
    assert.equal(results.get("node")?.status, "blocked");
    assert.match(results.get("node")?.notice ?? "", /node-deps/u);
    assert.equal(dependentRan, false, "a blocked step never runs");
});

test("runPass_noFix_keepsStepOrderRegardlessOfCompletionOrder", async () => {
    // Arrange
    const first = deferred<void>();
    const second = deferred<void>();

    // Act
    const pass = runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        concurrency: 2,
        steps: [
            {
                id: "first",
                run: async () => {
                    await first.promise;
                    return passed({});
                },
            },
            {
                id: "second",
                run: async () => {
                    await second.promise;
                    return passed({});
                },
            },
        ],
    });
    // Resolve the later step first: completion order is second, then first.
    second.resolve();
    await flushMicrotasks();
    first.resolve();

    // Assert
    const results = await pass;
    assert.deepEqual([...results.keys()], ["first", "second"]);
});

test("runPass_noFix_emitsTimingsInStepOrder", async () => {
    // Arrange
    const labels: string[] = [];
    const timings: Timings = { record: (label) => labels.push(label) };
    const first = deferred<void>();
    const second = deferred<void>();

    // Act
    const pass = runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        timings,
        concurrency: 2,
        steps: [
            {
                id: "first",
                run: async () => {
                    await first.promise;
                    return passed({});
                },
            },
            {
                id: "second",
                run: async () => {
                    await second.promise;
                    return passed({});
                },
            },
        ],
    });
    second.resolve();
    await flushMicrotasks();
    first.resolve();
    await pass;

    // Assert
    assert.deepEqual(labels, ["no-fix/first", "no-fix/second"]);
});

test("runPass_fix_runsStepsSequentially", async () => {
    // Arrange
    let active = 0;
    let peak = 0;
    const steps = ["a", "b", "c"].map((id) => ({
        id,
        run: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await flushMicrotasks();
            active -= 1;
            return passed({});
        },
    }));

    // Act
    await runPass({
        mode: "fix",
        repoRoot: "/repo",
        files: [],
        steps,
        concurrency: 4,
    });

    // Assert
    assert.equal(peak, 1, "repair never runs steps together");
});

test("runPass_noFix_signal_cancelsUnstartedSteps", async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();
    const touched: string[] = [];

    // Act
    const results = await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        signal: controller.signal,
        concurrency: 1,
        steps: [
            {
                id: "a",
                run: async () => {
                    touched.push("a");
                    return passed({});
                },
            },
            {
                id: "b",
                run: async () => {
                    touched.push("b");
                    return passed({});
                },
            },
        ],
    });

    // Assert
    assert.deepEqual(touched, [], "no step starts after abort");
    assert.equal(results.get("a")?.status, "error");
    assert.match(results.get("a")?.notice ?? "", /cancelled/u);
    assert.equal(results.get("b")?.status, "error");
});

test("runPass_noFix_signal_stopsLaunchingFurtherSteps", async () => {
    // Arrange
    const controller = new AbortController();
    const firstDone = deferred<void>();
    const started: string[] = [];

    // Act
    const pass = runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        signal: controller.signal,
        concurrency: 1,
        steps: [
            {
                id: "a",
                run: async () => {
                    started.push("a");
                    await firstDone.promise;
                    return passed({});
                },
            },
            {
                id: "b",
                run: async () => {
                    started.push("b");
                    return passed({});
                },
            },
        ],
    });

    // Assert
    assert.deepEqual(started, ["a"], "only the first step starts at bound 1");

    // Act
    controller.abort();
    firstDone.resolve();
    const results = await pass;

    // Assert
    assert.deepEqual(started, ["a"], "the pending step never starts");
    assert.equal(results.get("a")?.status, "pass", "a running step completes");
    assert.match(results.get("b")?.notice ?? "", /cancelled/u);
});

test("cancellableRunner_forwardsTheSignalToTheWrappedRunner", async () => {
    // Arrange
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const fake = (async (options: {
        signal?: AbortSignal;
    }): Promise<CommandResult> => {
        seen.push(options.signal);
        return {
            status: 0,
            stdout: "",
            stderr: "",
            signal: null,
            timedOut: false,
            cancelled: false,
            truncated: false,
        };
    }) as unknown as typeof import("../lib/proc.mts").run;
    const runner = cancellableRunner({
        runner: fake,
        signal: controller.signal,
    });

    // Act
    await runner({ cmd: "true" });

    // Assert
    assert.equal(seen[0], controller.signal);
});

test("resolveConcurrency_prefersOverrideThenEnvThenDefault", () => {
    // Arrange
    const previous = process.env.DEFINED_CONCURRENCY;

    // Act & Assert
    try {
        delete process.env.DEFINED_CONCURRENCY;
        assert.equal(resolveConcurrency(), DEFAULT_CONCURRENCY);
        process.env.DEFINED_CONCURRENCY = "7";
        assert.equal(resolveConcurrency(), 7);
        assert.equal(resolveConcurrency({ override: 2 }), 2);
        process.env.DEFINED_CONCURRENCY = "0";
        assert.equal(resolveConcurrency(), DEFAULT_CONCURRENCY);
        process.env.DEFINED_CONCURRENCY = "nonsense";
        assert.equal(resolveConcurrency(), DEFAULT_CONCURRENCY);
    } finally {
        if (previous === undefined) {
            delete process.env.DEFINED_CONCURRENCY;
        } else {
            process.env.DEFINED_CONCURRENCY = previous;
        }
    }
});

test("acquireComplyLock_busy_printsTheBusyResultAndExits", async () => {
    // Arrange
    const printed: string[] = [];
    const exits: number[] = [];
    const lock: LockInfo = {
        pid: 99,
        startedAt: "2026-10-04T00:00:00.000Z",
        checkout: "/repo",
        command: "comply",
    };

    // Act
    const handle = await acquireComplyLock({
        repoRoot: "/repo",
        files: ["src/a.ts"],
        deps: {
            absoluteGitDirFn: async () => "/repo/.git",
            acquireLockFn: () =>
                ({
                    kind: "busy",
                    lock,
                    newerThanRun: ["src/a.ts"],
                }) satisfies AcquireLockResult,
            printFn: (line) => printed.push(line),
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert
    assert.equal(handle, undefined, "a contended run takes no handle");
    assert.deepEqual(exits, [1], "busy is a non-zero exit, never green");
    assert.deepEqual(JSON.parse(printed[0]!), {
        status: "busy",
        lock,
        newerThanRun: ["src/a.ts"],
    });
});

test("acquireComplyLock_acquired_returnsTheHandleAndDoesNotExit", async () => {
    // Arrange
    const printed: string[] = [];
    const exits: number[] = [];
    let released = 0;

    // Act
    const handle = await acquireComplyLock({
        repoRoot: "/repo",
        files: [],
        deps: {
            absoluteGitDirFn: async () => "/repo/.git",
            acquireLockFn: () =>
                ({
                    kind: "acquired",
                    handle: {
                        path: "/repo/.git/defined.lock",
                        info: {
                            pid: 1,
                            startedAt: "2026-10-04T00:00:00.000Z",
                            checkout: "/repo",
                            command: "comply",
                        },
                        release: () => {
                            released += 1;
                        },
                    },
                }) satisfies AcquireLockResult,
            printFn: (line) => printed.push(line),
            exitFn: (code) => exits.push(code),
        },
    });

    // Assert
    assert.notEqual(handle, undefined);
    handle?.release();
    assert.equal(released, 1, "the caller releases the lock it was given");
    assert.deepEqual(printed, []);
    assert.deepEqual(exits, []);
});

test("runPass keeps the whole inventory for the scratch and narrows the checks", async () => {
    // Arrange
    const seen: { files: string[]; checkFiles: string[] }[] = [];
    const files = ["src/app/main.ts", "terraform/main.tf"];

    // Act
    await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files,
        scope: ["src/**"],
        steps: [
            {
                id: "node",
                run: async ({ files: all, checkFiles }) => {
                    seen.push({ files: all, checkFiles });
                    return passed({});
                },
            },
        ],
    });

    // Assert
    assert.deepEqual(seen, [{ files, checkFiles: ["src/app/main.ts"] }]);
});

test("runPass leaves the whole inventory in place when no scope is declared", async () => {
    // Arrange
    const seen: string[][] = [];
    const files = ["src/app/main.ts", "terraform/main.tf"];

    // Act
    await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files,
        steps: [
            {
                id: "node",
                run: async ({ checkFiles }) => {
                    seen.push(checkFiles);
                    return passed({});
                },
            },
        ],
    });

    // Assert
    assert.deepEqual(seen, [files]);
});

test("runPass fails the scoped steps when the scope matches nothing", async () => {
    // Arrange
    const touched: string[] = [];

    // Act
    const results = await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: ["src/app/main.ts"],
        scope: ["docs/**"],
        steps: [
            {
                id: "node",
                scoped: true,
                run: async () => {
                    touched.push("node");
                    return passed({});
                },
            },
            {
                id: "workflow",
                run: async () => {
                    touched.push("workflow");
                    return passed({});
                },
            },
        ],
    });

    // Assert
    assert.deepEqual(touched, ["workflow"], "gate machinery still runs");
    assert.equal(results.get("node")?.status, "error");
    assert.match(
        results.get("node")?.errors[0]?.message ?? "",
        /scope: scope\.include matches no file in the git scope \(1 selector\(s\)\)/u,
    );
});

test("the run plan scopes exactly the content checks", async () => {
    // Arrange
    const expected = [
        "eslint",
        "node",
        "purity",
        "shell",
        "test-hygiene",
        "tofu",
        "yaml",
    ];

    // Act
    const actual = [...SCOPED_STEP_IDS].sort();

    // Assert
    assert.deepEqual(actual, expected);
});

/**
 * A temp repo whose `.defined.json` declares `scope.include: ["src/**"]`, so a
 * gate run can resolve a real config without a bootstrap phase.
 */
async function withScopedConfig(
    run: (repoRoot: string) => Promise<void>,
): Promise<void> {
    const repoRoot = await mkdtemp(join(tmpdir(), "quality-scope-"));
    await writeFile(
        join(repoRoot, ".defined.json"),
        JSON.stringify({ scope: { include: ["src/**"] } }),
    );
    try {
        await run(repoRoot);
    } finally {
        await rm(repoRoot, { recursive: true, force: true });
    }
}

test("runGate_scan passes the declared scope to the pass", async () => {
    // Arrange
    const scopes: (string[] | undefined)[] = [];

    // Act
    await withScopedConfig(async (repoRoot) => {
        await runGate({
            verb: "scan",
            repoRoot,
            files: [],
            deps: {
                runPassFn: async (input) => {
                    scopes.push(input.scope);
                    return allGreen();
                },
                printFn: () => undefined,
                exitFn: () => undefined,
            },
        });
    });

    // Assert
    assert.deepEqual(scopes, [["src/**"]]);
});

test("runGate_comply passes the declared scope to both passes", async () => {
    // Arrange
    const scopes: (string[] | undefined)[] = [];

    // Act
    await withScopedConfig(async (repoRoot) => {
        await runGate({
            verb: "comply",
            repoRoot,
            files: [],
            deps: {
                runSetupFn: async () => undefined,
                checkSetupFn: async () => cleanSetup(),
                trackedFilesFn: async () => [],
                runPassFn: async (input) => {
                    scopes.push(input.scope);
                    return allGreen();
                },
                printFn: () => undefined,
                exitFn: () => undefined,
            },
        });
    });

    // Assert
    assert.deepEqual(scopes, [["src/**"], ["src/**"]]);
});

test("runGate_scan_surfacesTheConsumerConfigDriftWithoutBootstrap", async () => {
    // Arrange
    const repoRoot = await mkdtemp(join(tmpdir(), "quality-scan-scope-"));
    await writeFile(
        join(repoRoot, ".defined.json"),
        JSON.stringify({ scope: { include: ["src/**"] } }),
    );
    const printed: string[] = [];
    try {
        // Act
        await runGate({
            verb: "scan",
            repoRoot,
            files: [],
            deps: {
                runPassFn: async () => allGreen(),
                printFn: (line) => printed.push(line),
                exitFn: () => undefined,
            },
        });
    } finally {
        await rm(repoRoot, { recursive: true, force: true });
    }

    // Assert
    const result = parsePrinted(printed);
    assert.equal(result.status, "compliant");
    assert.equal(result.notices?.length, 1);
    assert.match(
        result.notices?.[0]?.message ?? "",
        /scope\.include: narrows the content checks to 1 selector\(s\)/u,
    );
});

test("runPass gives the review files to steps beside the content scope", async () => {
    // Arrange
    const seen: Array<{
        checkFiles: string[];
        reviewFiles?: readonly string[];
    }> = [];

    // Act
    await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: ["src/a.ts", "src/b.ts"],
        scope: ["src/**"],
        reviewFiles: ["src/b.ts"],
        steps: [
            {
                id: "probe",
                scoped: true,
                run: async ({ checkFiles, reviewFiles }) => {
                    seen.push({ checkFiles, reviewFiles });
                    return passed({});
                },
            },
        ],
    });

    // Assert
    assert.deepEqual(seen, [
        {
            checkFiles: ["src/a.ts", "src/b.ts"],
            reviewFiles: ["src/b.ts"],
        },
    ]);
});

test("runGate_scan passes the review files to the pass", async () => {
    // Arrange
    const seen: (readonly string[] | undefined)[] = [];

    // Act
    await withScopedConfig(async (repoRoot) => {
        await runGate({
            verb: "scan",
            repoRoot,
            files: [],
            reviewFiles: ["src/a.test.ts"],
            deps: {
                runPassFn: async (input) => {
                    seen.push(input.reviewFiles);
                    return allGreen();
                },
                printFn: () => undefined,
                exitFn: () => undefined,
            },
        });
    });

    // Assert
    assert.deepEqual(seen, [["src/a.test.ts"]]);
});

test("settleExit records the status without ending the process", () => {
    // Arrange — node:test shares this process, so the previous status is
    // restored afterwards rather than leaking a failing status onto the suite.
    const previous = process.exitCode;

    try {
        for (const exitCode of [0, 1, 2]) {
            // Act
            settleExit(exitCode);

            // Assert
            assert.equal(process.exitCode, exitCode);
        }
    } finally {
        process.exitCode = previous;
    }
});
