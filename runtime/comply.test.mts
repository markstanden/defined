// Tests for comply.mts: the orchestrator's pass loop, two-verb flows and exit
// contract. The heavy tool/setup logic lives in the step modules and
// setup.mts, each tested separately — here we drive the wiring with fakes.
// Run: node --test comply.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    cancellableRunner,
    CONSUMER_RESOURCE,
    DEFAULT_CONCURRENCY,
    printUsage,
    resolveConcurrency,
    runExplain,
    runGate,
    runPass,
    runSmoke,
    STEP_IDS,
} from "./comply.mts";
import { STEP_IDS as EXPLAIN_STEP_IDS } from "./lib/explain.mts";
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
    const results = await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        steps: [fakeStep("node", passed({})), fakeStep("shell", failed({}))],
    });
    assert.deepEqual(
        [...results].map(([id, r]) => [id, r.status]),
        [
            ["node", "pass"],
            ["shell", "fail"],
        ],
    );
});

test("runPass forwards the mode to each step", async () => {
    const modes: string[] = [];
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
    assert.deepEqual(modes, ["fix"]);
    assert.equal(results.get("probe")?.status, "pass");
});

test("runPass_recordsAThrownStepAsAnErrorAndContinues", async () => {
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
    assert.equal(results.get("broken")?.status, "error");
    assert.deepEqual(results.get("broken")?.errors, [
        { kind: "execution", message: "cannot run 'tool': not found" },
    ]);
    assert.equal(results.get("after")?.status, "pass");
});

test("runPass_withTimings_recordsEachStepUnderItsMode", async () => {
    const labels: string[] = [];
    const timings: Timings = { record: (label) => labels.push(label) };
    await runPass({
        mode: "fix",
        repoRoot: "/repo",
        files: [],
        timings,
        steps: [fakeStep("node", passed({})), fakeStep("shell", passed({}))],
    });
    assert.deepEqual(labels, ["fix/node", "fix/shell"]);
});

test("runGate_complyGreen_printsOneCompliantResultAndDoesNotExit", async () => {
    const printed: string[] = [];
    const exits: number[] = [];
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
    const printed: string[] = [];
    const exits: number[] = [];
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
    const result = parsePrinted(printed);
    assert.equal(result.status, "not_compliant");
    assert.equal(result.results.workflow, "fail");
    assert.deepEqual(result.errors, [
        { check: "workflow", kind: "finding", message: "actionlint failed" },
    ]);
    assert.deepEqual(exits, [1]);
});

test("runGate_complyBootstrapDrift_reportsItThroughTheCanonicalResult", async () => {
    const printed: string[] = [];
    const exits: number[] = [];
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
    const passedFiles: string[][] = [];
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
    // Both passes see the post-bootstrap snapshot, never the pre-setup one.
    assert.deepEqual(passedFiles, [["post-setup.txt"], ["post-setup.txt"]]);
});

test("runGate_comply_reFetchesTrackedFilesAfterRepair", async () => {
    const verifyFiles: string[][] = [];
    let fetches = 0;
    const passes: string[] = [];
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
    // The repair pass sees the post-setup snapshot; verification re-fetches
    // after repairs so a file created by a fixer is checked (#62).
    assert.deepEqual(passes, ["fix", "no-fix"]);
    assert.deepEqual(verifyFiles, [["after-repair.txt"]]);
    assert.equal(fetches, 2, "setup refresh + a fresh fetch after repair");
});

test("runGate_comply_marksBothPassesRepoWritable", async () => {
    const flags: Array<boolean | undefined> = [];
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
    // Comply is write-capable: both passes run report steps in the repo, so the
    // coverage artifact a scanner reads survives the run (#65).
    assert.deepEqual(flags, [true, true]);
});

test("runGate_verify_leavesPassesReadOnly", async () => {
    const flags: Array<boolean | undefined> = [];
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
    // A read-only verify never opts into writing the repo mount.
    assert.deepEqual(flags, [undefined]);
});

test("runGate_comply_reRenameLeavesNoStaleVerificationPath", async () => {
    const verifyFiles: string[][] = [];
    const snapshots = [
        ["Old.cs", "Keep.cs"],
        ["New.cs", "Keep.cs"],
    ];
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
    // Verification judges the post-repair tree: it sees the new name and never
    // the stale one, which the no-fix scratch copy would fail to find (#62).
    assert.deepEqual(verifyFiles, [["New.cs", "Keep.cs"]]);
    assert.equal(verifyFiles[0]!.includes("Old.cs"), false);
});

test("runGate_verify_checksSetupThenRunsTheNoFixPass", async () => {
    const printed: string[] = [];
    const exits: number[] = [];
    const setupCalls: string[] = [];
    await runGate({
        verb: "verify",
        repoRoot: "/repo",
        files: [],
        deps: {
            checkSetupFn: async ({ startDir }) => {
                setupCalls.push(startDir);
                return cleanSetup();
            },
            runPassFn: async () => allGreen(),
            printFn: (line) => printed.push(line),
            exitFn: (code) => exits.push(code),
        },
    });
    assert.deepEqual(setupCalls, ["/repo"]);
    assert.equal(parsePrinted(printed).status, "compliant");
    assert.deepEqual(exits, []);
});

test("runGate_verifyFailingStep_exitsOne", async () => {
    const exits: number[] = [];
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
    assert.deepEqual(exits, [1]);
});

test("runGate_defaultsToMinPresentation", async () => {
    const printed: string[] = [];
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
    // The default is min: no results map, just the verdict.
    assert.deepEqual(printed, ['{"status":"compliant"}']);
});

test("runGate_minGreen_printsOnlyTheStatus", async () => {
    const printed: string[] = [];
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
    assert.deepEqual(printed, ['{"status":"compliant"}']);
});

test("runGate_minFailure_keepsDiagnosticsButDropsResults", async () => {
    const printed: string[] = [];
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
    const result = JSON.parse(printed[0]!);
    assert.equal(result.status, "not_compliant");
    assert.equal("results" in result, false);
    assert.deepEqual(result.errors, [
        { check: "workflow", kind: "finding", message: "actionlint failed" },
    ]);
});

test("runGate_timings_writesDurationsToStderrAndLeavesStdoutAlone", async () => {
    const printed: string[] = [];
    const notified: string[] = [];
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
    const notified: string[] = [];
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
    assert.deepEqual(notified, []);
});

test("runExplain_printsOneJsonObjectAndDoesNotExit", async () => {
    const printed: string[] = [];
    const exits: number[] = [];
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
    assert.equal(printed.length, 1, "exactly one JSON line on stdout");
    assert.equal(JSON.parse(printed[0]!).topic, "shell");
    assert.deepEqual(exits, []);
});

test("runExplain_unknownTopic_reportsToStderrAndExitsTwo", async () => {
    const errors: string[] = [];
    const exits: number[] = [];
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
    assert.match(errors[0]!, /unknown topic 'wat'/u);
    assert.deepEqual(exits, [2]);
});

test("explainStepIds_coverEveryOrchestratorStep", () => {
    assert.deepEqual(
        EXPLAIN_STEP_IDS.filter((id) => id !== "bootstrap"),
        STEP_IDS,
    );
});

test("printUsage prints the three-verb usage line with flags", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
        printUsage();
    } finally {
        console.log = original;
    }
    assert.deepEqual(lines, [
        "usage: defined comply [--min|--full] [--timings] | defined verify [--min|--full] [--timings] | defined explain <step-or-rule>",
    ]);
});

test("runSmoke probes /usr/bin/git in the container", async () => {
    const result = await runSmoke({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
    });
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
    const pass = runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        steps: [step("a", a), step("b", b)],
        concurrency: 2,
    });
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
    await runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        steps: [step("a"), step("b"), step("c")],
        concurrency: 4,
    });
    assert.equal(peak, 1, "resource holders never overlap");
});

test("runPass_noFix_neverExceedsTheConcurrencyBound", async () => {
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
    const pass = runPass({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
        steps,
        concurrency: 2,
    });
    assert.equal(active, 2, "two steps start at the bound");
    for (let i = 0; i < steps.length; i += 1) {
        assert.ok(active <= 2, `active ${active} exceeded the bound`);
        releases.shift()?.();
        await flushMicrotasks();
    }
    const results = await pass;
    assert.equal(peak, 2);
    assert.equal(
        [...results.values()].every((r) => r.status === "pass"),
        true,
    );
});

test("runPass_noFix_blocksDependentsOfAFailedPrerequisite", async () => {
    let dependentRan = false;
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
    assert.equal(results.get("node-deps")?.status, "fail");
    assert.equal(results.get("node")?.status, "blocked");
    assert.match(results.get("node")?.notice ?? "", /node-deps/u);
    assert.equal(dependentRan, false, "a blocked step never runs");
});

test("runPass_noFix_keepsStepOrderRegardlessOfCompletionOrder", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
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
    const results = await pass;
    assert.deepEqual([...results.keys()], ["first", "second"]);
});

test("runPass_noFix_emitsTimingsInStepOrder", async () => {
    const labels: string[] = [];
    const timings: Timings = { record: (label) => labels.push(label) };
    const first = deferred<void>();
    const second = deferred<void>();
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
    assert.deepEqual(labels, ["no-fix/first", "no-fix/second"]);
});

test("runPass_fix_runsStepsSequentially", async () => {
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
    await runPass({
        mode: "fix",
        repoRoot: "/repo",
        files: [],
        steps,
        concurrency: 4,
    });
    assert.equal(peak, 1, "repair never runs steps together");
});

test("runPass_noFix_signal_cancelsUnstartedSteps", async () => {
    const controller = new AbortController();
    controller.abort();
    const touched: string[] = [];
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
    assert.deepEqual(touched, [], "no step starts after abort");
    assert.equal(results.get("a")?.status, "error");
    assert.match(results.get("a")?.notice ?? "", /cancelled/u);
    assert.equal(results.get("b")?.status, "error");
});

test("runPass_noFix_signal_stopsLaunchingFurtherSteps", async () => {
    const controller = new AbortController();
    const firstDone = deferred<void>();
    const started: string[] = [];
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
    assert.deepEqual(started, ["a"], "only the first step starts at bound 1");
    controller.abort();
    firstDone.resolve();
    const results = await pass;
    assert.deepEqual(started, ["a"], "the pending step never starts");
    assert.equal(results.get("a")?.status, "pass", "a running step completes");
    assert.match(results.get("b")?.notice ?? "", /cancelled/u);
});

test("cancellableRunner_forwardsTheSignalToTheWrappedRunner", async () => {
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
    await runner({ cmd: "true" });
    assert.equal(seen[0], controller.signal);
});

test("resolveConcurrency_prefersOverrideThenEnvThenDefault", () => {
    const previous = process.env.DEFINED_CONCURRENCY;
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
