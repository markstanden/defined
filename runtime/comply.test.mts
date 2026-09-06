// Tests for comply.mts: the orchestrator's pass loop, two-verb flows and exit
// contract. The heavy tool/setup logic lives in the step modules and
// setup.mts, each tested separately — here we drive the wiring with fakes.
// Run: node --test comply.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { printUsage, runGate, runPass, runSmoke } from "./comply.mts";
import { failed, passed, type StepResult } from "./lib/step-result.mts";
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
        configs: [
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

test("runGate comply exits cleanly on a green pass", async () => {
    const printed: string[] = [];
    const exits: number[] = [];
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: [],
        deps: {
            runSetupFn: async () => undefined,
            trackedFilesFn: async () => [],
            runPassFn: async () => allGreen(),
            printFn: (line) => printed.push(line),
            exitFn: (code) => exits.push(code),
        },
    });
    assert.deepEqual(printed, ["compliant"]);
    assert.deepEqual(exits, [], "green comply must not exit non-zero");
});

test("runGate comply exits 1 when a finding survives repair", async () => {
    const printed: string[] = [];
    const exits: number[] = [];
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: [],
        deps: {
            runSetupFn: async () => undefined,
            trackedFilesFn: async () => [],
            runPassFn: async () => oneFail(),
            printFn: (line) => printed.push(line),
            exitFn: (code) => exits.push(code),
        },
    });
    assert.equal(printed[0], "not compliant after repair");
    assert.deepEqual(exits, [1]);
});

test("runGate comply re-fetches tracked files after bootstrap", async () => {
    const passedFiles: string[][] = [];
    await runGate({
        verb: "comply",
        repoRoot: "/repo",
        files: ["pre-setup.txt"],
        deps: {
            runSetupFn: async () => undefined,
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

test("runGate verify checks setup then runs the no-fix pass", async () => {
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
    assert.deepEqual(printed, ["compliant"]);
    assert.deepEqual(exits, []);
});

test("runGate verify exits 1 on a failing step", async () => {
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

test("printUsage prints the two-verb usage line", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
        printUsage();
    } finally {
        console.log = original;
    }
    assert.deepEqual(lines, ["usage: defined comply | defined verify"]);
});

test("runSmoke probes /usr/bin/git in the container", async () => {
    const result = await runSmoke({
        mode: "no-fix",
        repoRoot: "/repo",
        files: [],
    });
    assert.equal(result.status, "pass");
});
