#!/usr/bin/env node
// comply.mts — quality gate orchestrator (two-verb contract, decision #23).
//
// Public surface:
//   defined comply [--min|--full] [--timings]   bootstrap → repair (fix) pass
//                                   → fresh verify (no-fix) pass → JSON result.
//   defined verify [--min|--full] [--timings]   managed-artifact check (never
//                                   writes) → complete no-fix pass → JSON result.
//
// Exit is 0 only when the canonical result is `compliant`, 1 otherwise; the
// exit code derives from the result, never from the rendered text. Output is a
// single JSON line (lib/report.mts): `--min` (default) carries `status` and
// `errors` whenever any occurred; `--full` adds the per-check `results`.
// `--timings` is orthogonal: monotonic phase/step durations on stderr (#71),
// never touching stdout.
//
// Named comply.mts because it owns the `comply` verb — the always-use loop;
// `verify` shares the orchestrator. Steps run in fixed order (naming →
// node-deps → node → eslint → node-checks → node-coverage → dotnet →
// dotnet-coverage → shell → smoke → yaml → workflow → tofu), strictly
// sequentially.

import {
    createRunContext,
    parseCommand,
    type StepMode,
    type Verb,
} from "./lib/ctx.mts";
import { trackedFiles } from "../lib/git.mts";
import { run } from "../lib/proc.mts";
import { checkSetup, runSetup } from "./setup.mts";
import {
    buildResult,
    mergeRepairErrors,
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
import {
    errored,
    failed,
    passed,
    skipped,
    type StepResult,
} from "./lib/step-result.mts";
import { cleanupScratch, type Scratch } from "./lib/scratch.mts";
import { createTimings, measure, now, type Timings } from "./lib/timings.mts";
import { explainTopic, renderExplanation } from "./lib/explain.mts";

interface StepInput {
    mode: StepMode;
    repoRoot: string;
    /** Git-tracked files relative to repoRoot (lib/git.mts). */
    files: string[];
    /** Shared scratch box: the write-capable steps (node/dotnet families, tofu) work in /tmp for no-fix (findings #10, #20; issue #43). */
    scratch?: Scratch;
    /**
     * True for a write-capable invocation (`comply`): a no-fix step that
     * produces a report the consumer keeps (coverage, for SonarQube/CI) works
     * in the repo rather than a scratch that is discarded. Read-only `verify`
     * leaves it false, so the repo mount is never written.
     */
    repoWritable?: boolean;
}

interface Step {
    id: string;
    run: (input: StepInput) => Promise<StepResult>;
}

/**
 * Prove end-to-end container execution by probing git's version. Uses a
 * fixed absolute path (/usr/bin/git — the image installs git via apt on
 * Debian slim), so no PATH lookup is involved and the probe is deterministic.
 * Verification-only: repair skips it (#65).
 */
export async function runSmoke({ mode }: StepInput): Promise<StepResult> {
    if (mode === "fix") {
        return skipped({ notice: "smoke: deferred to verification" });
    }
    const probe = await run({ cmd: "/usr/bin/git", args: ["--version"] });
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
        run: ({ mode, repoRoot, files, scratch, repoWritable }) =>
            runNodeCoverageStep({
                ctx: { mode, repoRoot, scratch, repoWritable },
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
        run: ({ mode, repoRoot, files, scratch, repoWritable }) =>
            runDotNetCoverageStep({
                ctx: { mode, repoRoot, scratch, repoWritable },
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

/** The run-plan step ids, in order (the guide for `defined explain` coverage). */
export const STEP_IDS: readonly string[] = STEPS.map((step) => step.id);

/** Run every step in order in the given mode; nothing may crash silently. */
export async function runPass({
    mode,
    repoRoot,
    files,
    steps = STEPS,
    timings,
    repoWritable = false,
}: {
    mode: StepMode;
    repoRoot: string;
    files: string[];
    steps?: readonly Step[];
    /** Opt-in per-step durations, reported under `<mode>/<step>` (#71). */
    timings?: Timings;
    /** Write-capable invocation (`comply`): no-fix report steps work in the repo. */
    repoWritable?: boolean;
}): Promise<Map<string, StepResult>> {
    const results = new Map<string, StepResult>();
    for (const step of steps) {
        results.set(step.id, failed({ notice: "not started" }));
    }
    const scratch: Scratch = { dir: null };
    try {
        for (const step of steps) {
            const started = timings ? now() : 0;
            try {
                const result = await step.run({
                    mode,
                    repoRoot,
                    files,
                    scratch,
                    repoWritable,
                });
                results.set(step.id, result);
            } catch (err) {
                // A step that throws (missing binary, bad config) must never
                // abort the run: record it as an execution error and continue,
                // so the remaining checks still report and stdout stays JSON.
                const message =
                    err instanceof Error ? err.message : String(err);
                results.set(step.id, errored({ message }));
            }
            if (timings) {
                timings.record(`${mode}/${step.id}`, now() - started);
            }
        }
    } finally {
        cleanupScratch(scratch);
    }
    return results;
}

/** Report the verbs: the two result verbs with flags, and the guidance verb. */
export function printUsage(): void {
    console.log(
        "usage: defined comply [--min|--full] [--timings] | defined verify [--min|--full] [--timings] | defined explain <step-or-rule>",
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
    /** Stderr sink for opt-in timings (`--timings`). */
    notifyFn?: (line: string) => void;
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
    timings,
}: {
    repoRoot: string;
    files: string[];
    runSetupFn: typeof runSetup;
    checkSetupFn: typeof checkSetup;
    runPassFn: typeof runPass;
    trackedFilesFn: typeof trackedFiles;
    timings?: Timings;
}): Promise<GateResult> {
    await measure(timings, "setup", () => runSetupFn({ startDir: repoRoot }));
    // Bootstrap writes .editorconfig, Directory.Build.props, .gitattributes,
    // AGENTS.md and a pinned .defined.json — files the pre-bootstrap
    // snapshot (taken in main()) cannot contain. Re-fetch so both passes
    // judge the repo as it exists after setup; otherwise the node step's
    // prettier file list never sees the gate's own seeded files.
    const filesAfterSetup = await trackedFilesFn({ repoRoot });
    const repair = await measure(timings, "fix pass", () =>
        runPassFn({
            mode: "fix",
            repoRoot,
            files: filesAfterSetup,
            timings,
            repoWritable: true,
        }),
    );
    // Repairs mutate the tree: a fixer or a consumer command can create,
    // delete or rename files. Re-fetch so verification judges what is actually
    // on disk — a new file is checked, and a deleted path never reaches the
    // no-fix scratch copy, where copying a missing file would abort the pass.
    const filesAfterRepair = await trackedFilesFn({ repoRoot });
    const verify = await measure(timings, "no-fix pass", () =>
        runPassFn({
            mode: "no-fix",
            repoRoot,
            files: filesAfterRepair,
            timings,
            repoWritable: true,
        }),
    );
    // Report any gate-owned bootstrap artifact still out of line after setup
    // (the managed workflow and AGENTS block are brought to the gate copy; a
    // seeded default the repo owns is never gated) through the same canonical
    // result as the step findings — never a raw stack. A repair that failed
    // while mutating is folded in so it cannot hide behind green verification.
    const setup = await checkSetupFn({ startDir: repoRoot });
    return buildResult({
        setup,
        steps: mergeRepairErrors({ repair, verify }),
    });
}

/** The verify flow: read-only bootstrap check → complete no-fix pass → result. */
async function runVerify({
    repoRoot,
    files,
    checkSetupFn,
    runPassFn,
    timings,
}: {
    repoRoot: string;
    files: string[];
    checkSetupFn: typeof checkSetup;
    runPassFn: typeof runPass;
    timings?: Timings;
}): Promise<GateResult> {
    const setup = await measure(timings, "setup check", () =>
        checkSetupFn({ startDir: repoRoot }),
    );
    const results = await measure(timings, "no-fix pass", () =>
        runPassFn({ mode: "no-fix", repoRoot, files, timings }),
    );
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
        notifyFn = (line) => process.stderr.write(`${line}\n`),
        exitFn = (code) => process.exit(code),
    } = deps;
    return {
        runSetupFn,
        checkSetupFn,
        runPassFn,
        trackedFilesFn,
        printFn,
        notifyFn,
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
    presentation = "min",
    timings = false,
    deps = {},
}: {
    verb: Verb;
    repoRoot: string;
    files: string[];
    presentation?: Presentation;
    /** Opt-in monotonic phase/step durations on stderr (#71). */
    timings?: boolean;
    deps?: RunGateDeps;
}): Promise<void> {
    const resolved = resolveDeps(deps);
    const sink = timings
        ? createTimings({ sink: resolved.notifyFn })
        : undefined;
    const result = await measure(sink, `${verb} total`, () =>
        verb === "comply"
            ? runComply({
                  repoRoot,
                  files,
                  runSetupFn: resolved.runSetupFn,
                  checkSetupFn: resolved.checkSetupFn,
                  runPassFn: resolved.runPassFn,
                  trackedFilesFn: resolved.trackedFilesFn,
                  timings: sink,
              })
            : runVerify({
                  repoRoot,
                  files,
                  checkSetupFn: resolved.checkSetupFn,
                  runPassFn: resolved.runPassFn,
                  timings: sink,
              }),
    );
    resolved.printFn(renderResult({ result, presentation }));
    if (result.status !== "compliant") {
        resolved.exitFn(1);
    }
}

export interface RunExplainDeps {
    /** Guidance resolver; injected so tests need no image or repo. */
    explainFn?: typeof explainTopic;
    /** Output sink (stdout). */
    printFn?: (line: string) => void;
    /** Error sink (stderr). */
    errorFn?: (line: string) => void;
    /** Process exit; injected so tests observe the exit code. */
    exitFn?: (code: number) => void;
}

/**
 * `explain <topic>`: resolve guidance from the pinned image and print it as one
 * compact JSON line. A successful explain always exits 0; an unknown topic is a
 * concise stderr error and exit 2, so stdout never carries a partial object.
 */
export async function runExplain({
    topic,
    repoRoot,
    deps = {},
}: {
    topic: string;
    repoRoot: string;
    deps?: RunExplainDeps;
}): Promise<void> {
    const {
        explainFn = explainTopic,
        printFn = (line) => console.log(line),
        errorFn = (line) => console.error(line),
        exitFn = (code) => process.exit(code),
    } = deps;
    try {
        const explanation = await explainFn({ topic, repoRoot });
        printFn(renderExplanation(explanation));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errorFn(`explain: ${message}`);
        exitFn(2);
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
        timings: parsed!.timings,
    });
    if (ctx.verb === "explain") {
        await runExplain({ topic: parsed!.topic!, repoRoot: ctx.repoRoot });
        return;
    }
    const files = await trackedFiles({ repoRoot: ctx.repoRoot });
    await runGate({
        verb: ctx.verb,
        repoRoot: ctx.repoRoot,
        files,
        presentation: ctx.presentation,
        timings: ctx.timings,
    });
}

if (import.meta.main) {
    await main();
}
