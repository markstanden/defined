#!/usr/bin/env node
// comply.mts — quality gate orchestrator (two-verb contract, decision #23).
//
// Public surface:
//   defined comply [--min|--full]   bootstrap → repair (fix) pass → fresh
//                                   verify (no-fix) pass → JSON result.
//   defined verify [--min|--full]   managed-artifact check (never writes) →
//                                   complete no-fix pass → JSON result.
//
// Exit is 0 only when the canonical result is `compliant`, 1 otherwise; the
// exit code derives from the result, never from the rendered text. Output is a
// single JSON line (lib/report.mts): `--full` (default) includes the per-check
// `results`, `--min` drops them; both always carry `status` and include
// `errors` whenever any occurred.
//
// Named comply.mts because it owns the `comply` verb — the always-use loop;
// `verify` shares the orchestrator. Steps run in fixed order (naming →
// node-deps → node → eslint → node-checks → node-coverage → dotnet →
// dotnet-coverage → shell → smoke → yaml → workflow → tofu), strictly
// sequentially.

import { spawnSync } from "node:child_process";

import {
    createRunContext,
    parseCommand,
    type StepMode,
    type Verb,
} from "./lib/ctx.mts";
import { trackedFiles } from "../lib/git.mts";
import { checkSetup, runSetup } from "./setup.mts";
import {
    buildResult,
    renderResult,
    type GateResult,
    type Presentation,
} from "./lib/report.mts";
import { runDotNetStep } from "./steps/dotnet.mts";
import { runDotNetCoverageStep } from "./steps/dotnet-coverage.mts";
import { runEslintStep } from "./steps/eslint.mts";
import { runNamingStep } from "./steps/naming.mts";
import { runNodeChecksStep } from "./steps/node-checks.mts";
import { runNodeDepsStep } from "./steps/node-deps.mts";
import { runNodeStep } from "./steps/node.mts";
import { runNodeCoverageStep } from "./steps/node-coverage.mts";
import { runShellStep } from "./steps/shell.mts";
import { runTofuStep } from "./steps/tofu.mts";
import { runWorkflowStep } from "./steps/workflow.mts";
import { runYamlStep } from "./steps/yaml.mts";
import { failed, passed, type StepResult } from "./lib/step-result.mts";
import { cleanupScratch, type Scratch } from "./lib/scratch.mts";

interface StepInput {
    mode: StepMode;
    repoRoot: string;
    /** Git-tracked files relative to repoRoot (lib/git.mts). */
    files: string[];
    /** Shared scratch box: the write-capable steps (node/dotnet families, tofu) work in /tmp for no-fix (findings #10, #20; issue #43). */
    scratch?: Scratch;
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
        run: ({ mode, repoRoot, files, scratch }) =>
            runNamingStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
            }),
    },
    {
        id: "node-deps",
        run: ({ mode, repoRoot, files, scratch }) =>
            runNodeDepsStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
            }),
    },
    {
        id: "node",
        run: ({ mode, repoRoot, files, scratch }) =>
            runNodeStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
            }),
    },
    {
        id: "eslint",
        run: ({ mode, repoRoot, files, scratch }) =>
            runEslintStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
            }),
    },
    {
        id: "node-checks",
        run: ({ mode, repoRoot, files, scratch }) =>
            runNodeChecksStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
            }),
    },
    {
        id: "node-coverage",
        run: ({ mode, repoRoot, files, scratch }) =>
            runNodeCoverageStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
            }),
    },
    {
        id: "dotnet",
        run: ({ mode, repoRoot, files, scratch }) =>
            runDotNetStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
            }),
    },
    {
        id: "dotnet-coverage",
        run: ({ mode, repoRoot, files, scratch }) =>
            runDotNetCoverageStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
            }),
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
        run: ({ mode, repoRoot, files, scratch }) =>
            runTofuStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
            }),
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
    const scratch: Scratch = { dir: null };
    try {
        for (const step of steps) {
            const result = await step.run({ mode, repoRoot, files, scratch });
            results.set(step.id, result);
        }
    } finally {
        cleanupScratch(scratch);
    }
    return results;
}

/** Report the two verbs and their presentation flags. */
export function printUsage(): void {
    console.log(
        "usage: defined comply [--min|--full] | defined verify [--min|--full]",
    );
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
    /** Output sink. */
    printFn?: (line: string) => void;
    /** Process exit; injected so tests observe the exit code. */
    exitFn?: (code: number) => void;
}

/** The comply flow: bootstrap → repair (fix) pass → fresh no-fix pass → result. */
async function runComply({
    repoRoot,
    files,
    runSetupFn,
    checkSetupFn,
    runPassFn,
    trackedFilesFn,
}: {
    repoRoot: string;
    files: string[];
    runSetupFn: typeof runSetup;
    checkSetupFn: typeof checkSetup;
    runPassFn: typeof runPass;
    trackedFilesFn: typeof trackedFiles;
}): Promise<GateResult> {
    await runSetupFn({ startDir: repoRoot });
    // Bootstrap writes .editorconfig, Directory.Build.props, .gitattributes,
    // AGENTS.md and a pinned .defined.json — files the pre-bootstrap
    // snapshot (taken in main()) cannot contain. Re-fetch so both passes
    // judge the repo as it exists after setup; otherwise the node step's
    // prettier file list never sees the gate's own seeded files.
    const filesAfterSetup = trackedFilesFn({ repoRoot });
    await runPassFn({ mode: "fix", repoRoot, files: filesAfterSetup });
    const verify = await runPassFn({
        mode: "no-fix",
        repoRoot,
        files: filesAfterSetup,
    });
    // Report any gate-owned bootstrap artifact still out of line after setup
    // (the managed workflow and AGENTS block are brought to the gate copy; a
    // seeded default the repo owns is never gated) through the same canonical
    // result as the step findings — never a raw stack.
    const setup = await checkSetupFn({ startDir: repoRoot });
    return buildResult({
        setup,
        steps: [...verify].map(([id, result]) => ({ id, result })),
    });
}

/** The verify flow: read-only bootstrap check → complete no-fix pass → result. */
async function runVerify({
    repoRoot,
    files,
    checkSetupFn,
    runPassFn,
}: {
    repoRoot: string;
    files: string[];
    checkSetupFn: typeof checkSetup;
    runPassFn: typeof runPass;
}): Promise<GateResult> {
    const setup = await checkSetupFn({ startDir: repoRoot });
    const results = await runPassFn({ mode: "no-fix", repoRoot, files });
    return buildResult({
        setup,
        steps: [...results].map(([id, result]) => ({ id, result })),
    });
}

/** The injectable deps with their production defaults applied. */
function resolveDeps(deps: RunGateDeps): Required<RunGateDeps> {
    const {
        runSetupFn = runSetup,
        checkSetupFn = checkSetup,
        runPassFn = runPass,
        trackedFilesFn = trackedFiles,
        printFn = (line) => console.log(line),
        exitFn = (code) => process.exit(code),
    } = deps;
    return {
        runSetupFn,
        checkSetupFn,
        runPassFn,
        trackedFilesFn,
        printFn,
        exitFn,
    };
}

/**
 * Run the full two-verb flow against a repo and print one JSON result line.
 * `comply` bootstraps → repair (fix) pass → fresh verify (no-fix) pass, then
 * reports bootstrap state alongside the step findings; `verify` checks
 * bootstrap state then a complete no-fix pass. Exit 1 unless the result is
 * `compliant`. All deps are injectable for tests.
 */
export async function runGate({
    verb,
    repoRoot,
    files,
    presentation = "full",
    deps = {},
}: {
    verb: Verb;
    repoRoot: string;
    files: string[];
    presentation?: Presentation;
    deps?: RunGateDeps;
}): Promise<void> {
    const resolved = resolveDeps(deps);
    const result =
        verb === "comply"
            ? await runComply({
                  repoRoot,
                  files,
                  runSetupFn: resolved.runSetupFn,
                  checkSetupFn: resolved.checkSetupFn,
                  runPassFn: resolved.runPassFn,
                  trackedFilesFn: resolved.trackedFilesFn,
              })
            : await runVerify({
                  repoRoot,
                  files,
                  checkSetupFn: resolved.checkSetupFn,
                  runPassFn: resolved.runPassFn,
              });
    resolved.printFn(renderResult({ result, presentation }));
    if (result.status !== "compliant") {
        resolved.exitFn(1);
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
        presentation: parsed!.presentation,
    });
    const files = trackedFiles({ repoRoot: ctx.repoRoot });
    await runGate({
        verb: ctx.verb,
        repoRoot: ctx.repoRoot,
        files,
        presentation: ctx.presentation,
    });
}

if (import.meta.main) {
    await main();
}
