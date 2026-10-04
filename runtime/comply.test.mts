// Tests for comply.mts: the orchestrator's pass loop, two-verb flows and exit
// contract. The heavy tool/setup logic lives in the step modules and
// setup.mts, each tested separately — here we drive the wiring with fakes.
// Run: node --test comply.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    printUsage,
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
