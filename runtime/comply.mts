#!/usr/bin/env node
// comply.mts — quality gate orchestrator (two-verb contract, decision #23).
//
// Public surface:
//   defined comply   bootstrap → repair (fix) pass → fresh verify (no-fix)
//                    pass → exit 0 only when the final pass is green.
//   defined verify   managed-artifact check (never writes) → complete no-fix
//                    pass → non-zero for any drift, finding or failure.
//
// Named comply.mts because it owns the `comply` verb — the always-use loop;
// `verify` shares the orchestrator. Steps run in fixed order (naming → node →
// node-coverage → dotnet → dotnet-coverage → shell → yaml → workflow → tofu),
// strictly sequentially. Output follows the report contract (decision #24):
// green runs print exactly one `compliant` line; anything else prints a
// stable, agent-actionable breakdown.

import { spawnSync } from "node:child_process";

import {
    createRunContext,
    parseCommand,
    type StepMode,
    type Verb,
} from "./lib/ctx.mts";
import { trackedFiles } from "../lib/git.mts";
import { checkSetup, runSetup } from "./setup.mts";
import { formatReport } from "./lib/report.mts";
import { runDotNetStep } from "./steps/dotnet.mts";
import { runDotNetCoverageStep } from "./steps/dotnet-coverage.mts";
import { runNamingStep } from "./steps/naming.mts";
import { runNodeStep } from "./steps/node.mts";
import { runNodeCoverageStep } from "./steps/node-coverage.mts";
import { runShellStep } from "./steps/shell.mts";
import { runTofuStep } from "./steps/tofu.mts";
import { runWorkflowStep } from "./steps/workflow.mts";
import { runYamlStep } from "./steps/yaml.mts";
import { failed, passed, type StepResult } from "./lib/step-result.mts";

interface StepInput {
    mode: StepMode;
    repoRoot: string;
    /** Git-tracked files relative to repoRoot (lib/git.mts). */
    files: string[];
}

interface Step {
    id: string;
    run: (input: StepInput) => Promise<StepResult>;
}

/**
 * Prove end-to-end container execution by probing git's version. Uses a
 * fixed absolute path (/usr/bin/git — the image installs git via apt on
 * Debian slim), so no PATH lookup is involved and the probe is deterministic.
 */
export async function runSmoke(_input: StepInput): Promise<StepResult> {
    const probe = spawnSync("/usr/bin/git", ["--version"], {
        encoding: "utf8",
    });
    if (probe.status !== 0) {
        return failed({ notice: "git not available in container" });
    }
    return passed({ notice: `container exec ok (${probe.stdout.trim()})` });
}

const STEPS: Step[] = [
    {
        id: "naming",
        run: ({ mode, repoRoot, files }) =>
            runNamingStep({
                ctx: { mode, repoRoot },
                trackedFiles: files,
                enabled: false,
            }),
    },
    {
        id: "node",
        run: ({ mode, repoRoot, files }) =>
            runNodeStep({ ctx: { mode, repoRoot }, trackedFiles: files }),
    },
    {
        id: "node-coverage",
        run: ({ mode, repoRoot }) =>
            runNodeCoverageStep({ ctx: { mode, repoRoot } }),
    },
    {
        id: "dotnet",
        run: ({ mode, repoRoot, files }) =>
            runDotNetStep({ ctx: { mode, repoRoot }, trackedFiles: files }),
    },
    {
        id: "dotnet-coverage",
        run: ({ mode, repoRoot }) =>
            runDotNetCoverageStep({ ctx: { mode, repoRoot } }),
    },
    {
        id: "shell",
        run: ({ mode, repoRoot, files }) =>
            runShellStep({ ctx: { mode, repoRoot }, trackedFiles: files }),
    },
    { id: "smoke", run: runSmoke },
    {
        id: "yaml",
        run: ({ mode, repoRoot, files }) =>
            runYamlStep({ ctx: { mode, repoRoot }, trackedFiles: files }),
    },
    {
        id: "workflow",
        run: ({ mode, repoRoot, files }) =>
            runWorkflowStep({ ctx: { mode, repoRoot }, trackedFiles: files }),
    },
    {
        id: "tofu",
        run: ({ mode, repoRoot, files }) =>
            runTofuStep({ ctx: { mode, repoRoot }, trackedFiles: files }),
    },
];

/** Run every step in order in the given mode; nothing may crash silently. */
export async function runPass({
    mode,
    repoRoot,
    files,
    steps = STEPS,
}: {
    mode: StepMode;
    repoRoot: string;
    files: string[];
    steps?: readonly Step[];
}): Promise<Map<string, StepResult>> {
    const results = new Map<string, StepResult>();
    for (const step of steps) {
        results.set(step.id, failed({ notice: "not started" }));
    }
    for (const step of steps) {
        const result = await step.run({ mode, repoRoot, files });
        results.set(step.id, result);
    }
    return results;
}

export function printUsage(): void {
    console.log("usage: defined comply | defined verify");
}

export interface RunGateDeps {
    /** Bootstrap (comply only). Injected so tests need no real checkout. */
    runSetupFn?: typeof runSetup;
    /** Read-only bootstrap check (verify only). */
    checkSetupFn?: typeof checkSetup;
    /** Pass runner; injected so tests drive fake step results. */
    runPassFn?: typeof runPass;
    /** Re-fetch git-tracked files after bootstrap (comply creates files). */
    trackedFilesFn?: typeof trackedFiles;
    /** Report renderer. */
    reportFn?: typeof formatReport;
    /** Output sink. */
    printFn?: (line: string) => void;
    /** Process exit; injected so tests observe the exit code. */
    exitFn?: (code: number) => void;
}

/**
 * Run the full two-verb flow against a repo. `comply` bootstraps → repair
 * (fix) pass → fresh verify (no-fix) pass; `verify` checks bootstrap state
 * then a complete no-fix pass. Green = report's first line is `compliant`,
 * anything else exits 1. All deps are injectable for tests.
 */
export async function runGate({
    verb,
    repoRoot,
    files,
    deps = {},
}: {
    verb: Verb;
    repoRoot: string;
    files: string[];
    deps?: RunGateDeps;
}): Promise<void> {
    const {
        runSetupFn = runSetup,
        checkSetupFn = checkSetup,
        runPassFn = runPass,
        trackedFilesFn = trackedFiles,
        reportFn = formatReport,
        printFn = (line) => console.log(line),
        exitFn = (code) => process.exit(code),
    } = deps;

    if (verb === "comply") {
        await runSetupFn({ startDir: repoRoot });
        // Bootstrap writes .editorconfig, Directory.Build.props, AGENTS.md and
        // a pinned .defined.json — files the pre-bootstrap snapshot (taken in
        // main()) cannot contain. Re-fetch so both passes judge the repo as
        // it exists after setup; otherwise the node step's prettier file list
        // never sees the gate's own seeded files.
        const filesAfterSetup = await trackedFilesFn({ repoRoot });
        await runPassFn({ mode: "fix", repoRoot, files: filesAfterSetup });
        const verify = await runPassFn({
            mode: "no-fix",
            repoRoot,
            files: filesAfterSetup,
        });
        const lines = reportFn({
            verb: "comply",
            steps: [...verify].map(([id, result]) => ({ id, result })),
        });
        for (const line of lines) {
            printFn(line);
        }
        if (lines[0] !== "compliant") {
            exitFn(1);
        }
        return;
    }

    // `verify`: read-only bootstrap check → complete no-fix pass.
    const setup = await checkSetupFn({ startDir: repoRoot });
    const results = await runPassFn({ mode: "no-fix", repoRoot, files });
    const lines = reportFn({
        verb: "verify",
        setup,
        steps: [...results].map(([id, result]) => ({ id, result })),
    });
    for (const line of lines) {
        printFn(line);
    }
    if (lines[0] !== "compliant") {
        exitFn(1);
    }
}

async function main(): Promise<void> {
    const positional = process.argv.slice(2);

    let parsed;
    try {
        parsed = parseCommand({ argv: positional });
    } catch (err) {
        console.error(String(err));
        printUsage();
        process.exit(2);
    }
    if (parsed!.help) {
        printUsage();
        return;
    }

    const ctx = await createRunContext({
        verb: parsed!.verb,
        startDir: process.cwd(),
    });
    const files = trackedFiles({ repoRoot: ctx.repoRoot });
    await runGate({ verb: ctx.verb, repoRoot: ctx.repoRoot, files });
}

if (import.meta.main) {
    await main();
}
