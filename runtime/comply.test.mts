// Tests for comply.mts: the orchestrator's pass loop, two-verb flows and exit
// contract. The heavy tool/setup logic lives in the step modules and
// setup.mts, each tested separately — here we drive the wiring with fakes.
// Run: node --test comply.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { printUsage, runGate, runPass, runSmoke } from "./comply.mts";
import { failed, passed, type StepResult } from "./lib/step-result.mts";
import type { GateResult } from "./lib/report.mts";
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

test("runGate_complyGreen_printsOneCompliantResultAndDoesNotExit", async () => {
    const printed: string[] = [];
    const exits: number[] = [];
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: [],
        deps: {
            runSetupFn: async () => undefined,
            checkSetupFn: async () => cleanSetup(),
            trackedFilesFn: () => [],
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
        deps: {
            runSetupFn: async () => undefined,
            checkSetupFn: async () => cleanSetup(),
            trackedFilesFn: () => [],
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
        deps: {
            runSetupFn: async () => undefined,
            checkSetupFn: async () => ({
                files: [
                    { name: ".editorconfig", status: "drift" },
                    { name: "Directory.Build.props", status: "present" },
                ],
                agents: "present",
            }),
            trackedFilesFn: () => [],
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
            trackedFilesFn: () => ["post-setup.txt"],
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

test("printUsage prints the two-verb usage line with flags", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
        printUsage();
    } finally {
        console.log = original;
    }
    assert.deepEqual(lines, [
        "usage: defined comply [--min|--full] | defined verify [--min|--full]",
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
