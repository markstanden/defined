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
// `verify` shares the orchestrator. Steps are named in fixed order (naming →
// node-deps → node → eslint → node-checks → node-coverage → dotnet →
// dotnet-coverage → shell → smoke → yaml → workflow → tofu). Repair runs
// strictly sequentially; verification runs with bounded concurrency over the
// declared dependency edges and shared-resource locks (#70) — results stay
// deterministic in step order, and a signal cancels pending and running work.

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
    blocked,
    errored,
    failed,
    passed,
    skipped,
    type StepResult,
    type StepStatus,
} from "./lib/step-result.mts";
import { cleanupScratch, type Scratch } from "./lib/scratch.mts";
import { createTimings, measure, now, type Timings } from "./lib/timings.mts";
import { explainTopic, renderExplanation } from "./lib/explain.mts";

/** Child-process runner a pass injects into its steps (lib/proc.mts). */
type Runner = typeof run;

/** Default number of steps allowed to run at once (#70). */
export const DEFAULT_CONCURRENCY = 4;

/** Env overlay for the concurrency bound; invalid values fall back to default. */
const CONCURRENCY_ENV = "DEFINED_CONCURRENCY";

/**
 * Shared mutable resource for arbitrary consumer commands (#70): the consumer's
 * own rules/autofix, checks, coverage and build/test commands. Two steps that
 * both run consumer code never overlap, so output directories they share are
 * serialised. Steps whose writes are bounded and disjoint (node-deps installs
 * node_modules; node/eslint/shell/yaml/workflow read only) take no resource and
 * overlap freely.
 */
export const CONSUMER_RESOURCE = "consumer-command";

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
    /**
     * Child-process runner the pass injects — the cancellation-aware seam
     * (#70). Omitted for direct calls in tests, where a step's own
     * `runner = run` default applies.
     */
    runner?: Runner;
}

interface Step {
    id: string;
    run: (input: StepInput) => Promise<StepResult>;
    /**
     * Prerequisite step ids. A prerequisite that did not pass (or was skipped
     * cleanly) blocks this step rather than letting it run on half-restored
     * state (#70).
     */
    needs?: readonly string[];
    /**
     * Named mutable resources, as mutual-exclusion keys. Two steps sharing one
     * never run concurrently; a resource is not a dependency edge (see `needs`).
     */
    uses?: readonly string[];
}

/**
 * Prove end-to-end container execution by probing git's version. Uses a
 * fixed absolute path (/usr/bin/git — the image installs git via apt on
 * Debian slim), so no PATH lookup is involved and the probe is deterministic.
 * Verification-only: repair skips it (#65).
 */
export async function runSmoke({
    mode,
    runner = run,
}: StepInput): Promise<StepResult> {
    if (mode === "fix") {
        return skipped({ notice: "smoke: deferred to verification" });
    }
    const probe = await runner({ cmd: "/usr/bin/git", args: ["--version"] });
    if (probe.status !== 0) {
        return failed({ notice: "git not available in container" });
    }
    return passed({ notice: `container exec ok (${probe.stdout.trim()})` });
}

const STEPS: Step[] = [
    {
        id: "naming",
        uses: [CONSUMER_RESOURCE],
        run: ({ mode, repoRoot, files, scratch, runner }) =>
            runNamingStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
                runner,
            }),
    },
    {
        // The install contract is to materialise node_modules — a path no other
        // step writes — and the node family waits on it (`needs`), so it takes
        // no shared resource and may overlap the dotnet family (#70).
        id: "node-deps",
        run: ({ mode, repoRoot, files, scratch, runner }) =>
            runNodeDepsStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
                runner,
            }),
    },
    {
        id: "node",
        needs: ["node-deps"],
        run: ({ mode, repoRoot, files, scratch, runner }) =>
            runNodeStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
                runner,
            }),
    },
    {
        id: "eslint",
        needs: ["node-deps"],
        run: ({ mode, repoRoot, files, scratch, runner }) =>
            runEslintStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
                runner,
            }),
    },
    {
        id: "node-checks",
        needs: ["node-deps"],
        uses: [CONSUMER_RESOURCE],
        run: ({ mode, repoRoot, files, scratch, runner }) =>
            runNodeChecksStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
                runner,
            }),
    },
    {
        id: "node-coverage",
        needs: ["node-deps"],
        uses: [CONSUMER_RESOURCE],
        run: ({ mode, repoRoot, files, scratch, runner, repoWritable }) =>
            runNodeCoverageStep({
                ctx: { mode, repoRoot, scratch, repoWritable },
                trackedFiles: files,
                runner,
            }),
    },
    {
        id: "dotnet",
        uses: [CONSUMER_RESOURCE],
        run: ({ mode, repoRoot, files, scratch, runner }) =>
            runDotNetStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
                runner,
            }),
    },
    {
        id: "dotnet-coverage",
        needs: ["dotnet"],
        uses: [CONSUMER_RESOURCE],
        run: ({ mode, repoRoot, files, scratch, runner, repoWritable }) =>
            runDotNetCoverageStep({
                ctx: { mode, repoRoot, scratch, repoWritable },
                trackedFiles: files,
                runner,
            }),
    },
    {
        id: "shell",
        run: ({ mode, repoRoot, files, runner }) =>
            runShellStep({
                ctx: { mode, repoRoot },
                trackedFiles: files,
                runner,
            }),
    },
    { id: "smoke", run: runSmoke },
    {
        id: "yaml",
        run: ({ mode, repoRoot, files, runner }) =>
            runYamlStep({
                ctx: { mode, repoRoot },
                trackedFiles: files,
                runner,
            }),
    },
    {
        id: "workflow",
        run: ({ mode, repoRoot, files, runner }) =>
            runWorkflowStep({
                ctx: { mode, repoRoot },
                trackedFiles: files,
                runner,
            }),
    },
    {
        id: "tofu",
        uses: [CONSUMER_RESOURCE],
        run: ({ mode, repoRoot, files, scratch, runner }) =>
            runTofuStep({
                ctx: { mode, repoRoot, scratch },
                trackedFiles: files,
                runner,
            }),
    },
];

/** The run-plan step ids, in order (the guide for `defined explain` coverage). */
export const STEP_IDS: readonly string[] = STEPS.map((step) => step.id);

/**
 * Resolve the concurrency bound: an explicit override wins, then the
 * `DEFINED_CONCURRENCY` env overlay, then DEFAULT_CONCURRENCY. Anything that is
 * not a positive integer is ignored, so a bad value cannot wedge a run.
 */
export function resolveConcurrency({
    override,
}: { override?: number } = {}): number {
    if (override !== undefined) {
        return Math.max(1, Math.floor(override));
    }
    const raw = process.env[CONCURRENCY_ENV];
    if (raw === undefined) {
        return DEFAULT_CONCURRENCY;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0
        ? parsed
        : DEFAULT_CONCURRENCY;
}

/**
 * The runner a pass injects: every child inherits the pass's AbortSignal, so a
 * cancellation kills running work as well as stopping pending steps (#70). The
 * `runner` seam keeps this testable without spawning a process.
 */
export function cancellableRunner({
    runner = run,
    signal,
}: {
    runner?: Runner;
    signal?: AbortSignal;
} = {}): Runner {
    if (signal === undefined) {
        return runner;
    }
    return (options, spawnFn) => runner({ ...options, signal }, spawnFn);
}

/** True for a status that lets dependents proceed (a pass or a clean skip). */
function isSuccessful(status: StepStatus): boolean {
    return status === "pass" || status === "skip";
}

/** A step's prerequisite state during scheduling. */
type NeedsState =
    | { kind: "ready" }
    | { kind: "wait" }
    | { kind: "blocked"; needId: string; status: StepStatus };

/** Evaluate a step's `needs` against the results completed so far. */
function needsState({
    step,
    present,
    done,
}: {
    step: Step;
    present: ReadonlySet<string>;
    done: ReadonlyMap<string, StepResult>;
}): NeedsState {
    for (const needId of step.needs ?? []) {
        // A prerequisite outside this run's step list is not modelled, so it
        // cannot gate: tests inject subsets of steps.
        if (!present.has(needId)) {
            continue;
        }
        const result = done.get(needId);
        if (result === undefined) {
            return { kind: "wait" };
        }
        if (!isSuccessful(result.status)) {
            return { kind: "blocked", needId, status: result.status };
        }
    }
    return { kind: "ready" };
}

/** Run one step, turning a throw into an execution error (never aborting the pass). */
async function runStep(step: Step, input: StepInput): Promise<StepResult> {
    try {
        return await step.run(input);
    } catch (err) {
        // A step that throws (missing binary, bad config) must never abort the
        // run: record it as an execution error and continue, so the remaining
        // checks still report and stdout stays JSON.
        const message = err instanceof Error ? err.message : String(err);
        return errored({ message });
    }
}

/** Emit collected step durations in step order, so stderr stays deterministic. */
function emitTimings({
    timings,
    mode,
    steps,
    durations,
}: {
    timings: Timings | undefined;
    mode: StepMode;
    steps: readonly Step[];
    durations: ReadonlyMap<string, number>;
}): void {
    if (timings === undefined) {
        return;
    }
    for (const step of steps) {
        const ms = durations.get(step.id);
        if (ms !== undefined) {
            timings.record(`${mode}/${step.id}`, ms);
        }
    }
}

/** Initialise the results map in step order (its key order is the report order). */
function initialiseResults(steps: readonly Step[]): Map<string, StepResult> {
    const results = new Map<string, StepResult>();
    for (const step of steps) {
        results.set(step.id, failed({ notice: "not started" }));
    }
    return results;
}

/** Repair pass: strictly sequential, honouring a signal between steps. */
async function runSequential({
    steps,
    results,
    mode,
    timings,
    signal,
    input,
}: {
    steps: readonly Step[];
    results: Map<string, StepResult>;
    mode: StepMode;
    timings?: Timings;
    signal?: AbortSignal;
    input: StepInput;
}): Promise<void> {
    const durations = new Map<string, number>();
    for (const step of steps) {
        if (signal?.aborted === true) {
            results.set(
                step.id,
                errored({ message: `${step.id}: cancelled before start` }),
            );
            continue;
        }
        const started = timings ? now() : 0;
        results.set(step.id, await runStep(step, input));
        if (timings) {
            durations.set(step.id, now() - started);
        }
    }
    emitTimings({ timings, mode, steps, durations });
}

/**
 * Launch every ready pending step within the bound, blocking a dependent whose
 * prerequisite did not pass. Returns true when it changed any state, so the
 * caller can tell progress from a stuck schedule.
 */
function launchReady({
    steps,
    pending,
    running,
    present,
    done,
    bound,
    signal,
    start,
    finish,
    free,
}: {
    steps: readonly Step[];
    pending: Set<string>;
    running: ReadonlyMap<string, Promise<void>>;
    present: ReadonlySet<string>;
    done: ReadonlyMap<string, StepResult>;
    bound: number;
    signal?: AbortSignal;
    start: (step: Step) => void;
    finish: (step: Step, result: StepResult) => void;
    free: (step: Step) => boolean;
}): boolean {
    let progressed = false;
    for (const step of steps) {
        if (running.size >= bound || signal?.aborted === true) {
            break;
        }
        if (!pending.has(step.id)) {
            continue;
        }
        const needs = needsState({ step, present, done });
        if (needs.kind === "wait") {
            continue;
        }
        if (needs.kind === "blocked") {
            finish(
                step,
                blocked({
                    message: `${step.id}: blocked — prerequisite '${needs.needId}' ${needs.status}`,
                }),
            );
            progressed = true;
            continue;
        }
        if (!free(step)) {
            continue;
        }
        start(step);
        progressed = true;
    }
    return progressed;
}

/**
 * Give every still-pending step the same failure result, draining the schedule
 * after a cancellation or an unresolvable dependency cycle.
 */
function drainPending({
    steps,
    pending,
    finish,
    makeResult,
}: {
    steps: readonly Step[];
    pending: ReadonlySet<string>;
    finish: (step: Step, result: StepResult) => void;
    makeResult: (step: Step) => StepResult;
}): void {
    for (const step of steps) {
        if (pending.has(step.id)) {
            finish(step, makeResult(step));
        }
    }
}

/**
 * Verification pass: bounded concurrency over steps whose `needs` are satisfied
 * and whose `uses` resources do not conflict with a running step. A prerequisite
 * that did not pass blocks its dependents; a cancelled pass stops launching and
 * frees the scratch. Results stay keyed in step order (#70).
 */
async function runScheduled({
    steps,
    results,
    mode,
    timings,
    signal,
    input,
    bound,
}: {
    steps: readonly Step[];
    results: Map<string, StepResult>;
    mode: StepMode;
    timings?: Timings;
    signal?: AbortSignal;
    input: StepInput;
    bound: number;
}): Promise<void> {
    const present = new Set(steps.map((step) => step.id));
    const done = new Map<string, StepResult>();
    const pending = new Set(steps.map((step) => step.id));
    const running = new Map<string, Promise<void>>();
    const held = new Map<string, number>();
    const durations = new Map<string, number>();

    const finish = (step: Step, result: StepResult): void => {
        results.set(step.id, result);
        done.set(step.id, result);
        pending.delete(step.id);
    };
    const acquire = (step: Step): void => {
        for (const resource of step.uses ?? []) {
            held.set(resource, (held.get(resource) ?? 0) + 1);
        }
    };
    const release = (step: Step): void => {
        for (const resource of step.uses ?? []) {
            const next = (held.get(resource) ?? 1) - 1;
            if (next <= 0) {
                held.delete(resource);
            } else {
                held.set(resource, next);
            }
        }
    };
    const free = (step: Step): boolean =>
        (step.uses ?? []).every((resource) => (held.get(resource) ?? 0) === 0);
    const start = (step: Step): void => {
        pending.delete(step.id);
        acquire(step);
        const started = timings ? now() : 0;
        const settled = runStep(step, input).then((result) => {
            finish(step, result);
            release(step);
            if (timings) {
                durations.set(step.id, now() - started);
            }
            running.delete(step.id);
        });
        running.set(step.id, settled);
    };

    while (pending.size > 0 || running.size > 0) {
        const progressed = launchReady({
            steps,
            pending,
            running,
            present,
            done,
            bound,
            signal,
            start,
            finish,
            free,
        });
        if (running.size > 0) {
            await Promise.race(running.values());
            continue;
        }
        if (signal?.aborted === true) {
            drainPending({
                steps,
                pending,
                finish,
                makeResult: (step) =>
                    errored({ message: `${step.id}: cancelled before start` }),
            });
            break;
        }
        if (!progressed) {
            // Nothing runnable and nothing in flight: a dependency cycle or an
            // unsatisfiable schedule. Fail safe rather than spin forever.
            drainPending({
                steps,
                pending,
                finish,
                makeResult: (step) =>
                    errored({
                        message: `${step.id}: cannot be scheduled (unresolved prerequisite)`,
                    }),
            });
            break;
        }
    }
    emitTimings({ timings, mode, steps, durations });
}

/**
 * Run a pass of steps. Repair (`fix`) runs strictly sequentially; verification
 * (`no-fix`) runs with bounded concurrency respecting each step's `needs` and
 * `uses` (#70). Either way results are keyed in `steps` order, so the report is
 * deterministic whatever the completion order, and a step that throws is an
 * execution error, never a crashed pass. A `signal` cancels pending work and
 * kills running children via the injected runner.
 */
export async function runPass({
    mode,
    repoRoot,
    files,
    steps = STEPS,
    timings,
    repoWritable = false,
    concurrency,
    signal,
}: {
    mode: StepMode;
    repoRoot: string;
    files: string[];
    steps?: readonly Step[];
    /** Opt-in per-step durations, reported under `<mode>/<step>` (#71). */
    timings?: Timings;
    /** Write-capable invocation (`comply`): no-fix report steps work in the repo. */
    repoWritable?: boolean;
    /** Override the concurrency bound (tests); env/DEFAULT_CONCURRENCY otherwise. */
    concurrency?: number;
    /** Cancels pending steps and kills running children (#70). */
    signal?: AbortSignal;
}): Promise<Map<string, StepResult>> {
    const results = initialiseResults(steps);
    const scratch: Scratch = { dir: null };
    const input: StepInput = {
        mode,
        repoRoot,
        files,
        scratch,
        repoWritable,
        runner: cancellableRunner({ signal }),
    };
    try {
        if (mode === "fix") {
            await runSequential({
                steps,
                results,
                mode,
                timings,
                signal,
                input,
            });
        } else {
            await runScheduled({
                steps,
                results,
                mode,
                timings,
                signal,
                input,
                bound: resolveConcurrency({ override: concurrency }),
            });
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
    signal,
}: {
    repoRoot: string;
    files: string[];
    runSetupFn: typeof runSetup;
    checkSetupFn: typeof checkSetup;
    runPassFn: typeof runPass;
    trackedFilesFn: typeof trackedFiles;
    timings?: Timings;
    signal?: AbortSignal;
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
            signal,
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
            signal,
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
    signal,
}: {
    repoRoot: string;
    files: string[];
    checkSetupFn: typeof checkSetup;
    runPassFn: typeof runPass;
    timings?: Timings;
    signal?: AbortSignal;
}): Promise<GateResult> {
    const setup = await measure(timings, "setup check", () =>
        checkSetupFn({ startDir: repoRoot }),
    );
    const results = await measure(timings, "no-fix pass", () =>
        runPassFn({ mode: "no-fix", repoRoot, files, timings, signal }),
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
    signal,
    deps = {},
}: {
    verb: Verb;
    repoRoot: string;
    files: string[];
    presentation?: Presentation;
    /** Opt-in monotonic phase/step durations on stderr (#71). */
    timings?: boolean;
    /** Cancels the run: pending steps stop, running children are killed (#70). */
    signal?: AbortSignal;
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
                  signal,
              })
            : runVerify({
                  repoRoot,
                  files,
                  checkSetupFn: resolved.checkSetupFn,
                  runPassFn: resolved.runPassFn,
                  timings: sink,
                  signal,
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
    // A cancellation (Ctrl-C / SIGTERM) stops pending steps and kills running
    // children through the runner's AbortSignal (#70); the gate then reports and
    // exits non-zero rather than dying mid-run.
    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
        await runGate({
            verb: ctx.verb,
            repoRoot: ctx.repoRoot,
            files,
            presentation: ctx.presentation,
            timings: ctx.timings,
            signal: controller.signal,
        });
    } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    }
}

if (import.meta.main) {
    await main();
}
