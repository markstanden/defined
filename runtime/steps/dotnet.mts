// steps/dotnet.mts — .NET projects: restore, format, build, test via dotnet CLI.
//
// Tools:    dotnet SDK (restore, format, build, test)
// Config:   .editorconfig, Directory.Build.props installed by gate setup;
//           projects may add stricter rules via .defined.json
// Fix:      dotnet format rewrites, then step re-verifies — a fix that
//           leaves diffs can never read as success
// Restore:  always runs first into the container-shadowed NuGet cache
//           (decision #3) — build/test use --no-restore so a failed restore
//           fails here, loudly, before anything builds.
//
// Detection is sync and data-driven: activation = at least one tracked
// *.csproj, *.sln, or *.slnx file, unless `.defined.json` sets
// "dotnet": { "disable": true }. Workspace discovery follows
// dev-tools' pattern: explicit flag/env → single slnx/sln at root → repo root.
// The runner is injected so tests need no host binaries.
//
// Read-only verify (local `defined verify` and CI) cannot write obj/bin into
// the repo, so no-fix mode runs against a scratch copy of the git scope under
// /tmp (lib/scratch.mts, finding #10); the repo mount stays untouched. Fix
// mode runs in the repo as before.

import {
    failed,
    passed,
    skipped,
    type StepResult,
} from "../lib/step-result.mts";
import { ensureScratch, type Scratch } from "../lib/scratch.mts";
import { run, failureDetail, type CommandResult } from "../../lib/proc.mts";
import { loadConfig, type DefinedConfig } from "../lib/config.mts";
import { join } from "node:path";

export interface DotNetRunContext {
    /** Repair (fix) or authoritative verification (no-fix) — see comply #65. */
    mode: "fix" | "no-fix";
    /** Repo root the checkout was mounted at; scratch copies hang off it. */
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the dotnet + coverage steps. */
    scratch?: Scratch;
}

type Runner = typeof run;

/**
 * The .NET-relevant subset of the tracked file list: manifests and solutions.
 * Detection is data-driven (no filesystem) so callers can decide cheaply.
 *
 * @param root0 the parameter object
 * @param root0.files the gate's git-scoped file list, repo-relative
 * @returns the tracked .csproj/.sln/.slnx paths, in order
 */
export function filterDotNetFiles({ files }: { files: string[] }): string[] {
    return files.filter((file) => /\.(csproj|sln|slnx)$/u.test(file));
}

export interface DiscoverWorkspaceInput {
    /** The (scratch or repo) root the workspace resolution is relative to. */
    repoRoot: string;
    /** Explicit workspace path from TOOL_WORKSPACE; wins over every file. */
    workspaceEnv?: string;
    /** Tracked .slnx files at any depth. */
    slnxFiles: string[];
    /** Tracked .sln files at any depth. */
    slnFiles: string[];
    /** Tracked .csproj files at any depth. */
    csprojFiles: string[];
}

/**
 * A bounded name list for an error message: the first five paths, then the
 * number left out, so a repository with dozens of projects still reads.
 */
function boundedList(paths: readonly string[]): string {
    const head = paths.slice(0, 5).join(", ");
    const rest = paths.length - 5;
    return rest > 0 ? `${head} and ${rest} more` : head;
}

/**
 * Discover the .NET workspace to operate on.
 * Priority: explicit env → single .slnx → single .sln → single .csproj →
 * repo root. The csproj resolution matters: the CLI cannot operate on a bare
 * directory that merely *contains* a project, so a lone nested project must be
 * passed by path. Solutions are collected at any depth, not only at the root.
 * Throws on multiple solutions, or multiple projects with no solution, without
 * explicit selection; the message lists the first few paths and a count.
 */
export function discoverWorkspace({
    repoRoot,
    workspaceEnv,
    slnxFiles,
    slnFiles,
    csprojFiles,
}: DiscoverWorkspaceInput): string {
    if (workspaceEnv && workspaceEnv.length > 0) {
        return workspaceEnv;
    }
    if (slnxFiles.length === 1 && slnFiles.length === 0) {
        return `${repoRoot}/${slnxFiles[0]!}`;
    }
    if (slnFiles.length === 1 && slnxFiles.length === 0) {
        return `${repoRoot}/${slnFiles[0]!}`;
    }
    if (slnxFiles.length + slnFiles.length > 1) {
        throw new Error(
            `Multiple solution files found in the repository; use --workspace or TOOL_WORKSPACE: ${boundedList(
                [...slnxFiles, ...slnFiles],
            )}`,
        );
    }
    if (csprojFiles.length === 1) {
        return `${repoRoot}/${csprojFiles[0]!}`;
    }
    if (csprojFiles.length > 1) {
        throw new Error(
            `Multiple .csproj files with no solution; use --workspace or TOOL_WORKSPACE: ${boundedList(
                csprojFiles,
            )}`,
        );
    }
    return repoRoot;
}

function runDotNetCommand(
    runner: Runner,
    args: string[],
    cwd: string,
): Promise<CommandResult> {
    return runner({ cmd: "dotnet", args, cwd });
}

/**
 * The repair phase: restore (a prerequisite for formatting) then `dotnet
 * format` (the mutation). Verification — `format --verify-no-changes`, build,
 * test — never runs here: the orchestrator's single authoritative no-fix pass
 * owns it (#65). Returns the failed result, or null when the mutation
 * succeeded.
 */
async function runRestoreAndFormat({
    runner,
    workspace,
    workspaceRoot,
    mode,
    label = "",
}: {
    runner: Runner;
    workspace: string;
    workspaceRoot: string;
    mode: DotNetRunContext["mode"];
    /** Suffix naming the workspace when several are gated at once. */
    label?: string;
}): Promise<StepResult | null> {
    // Restore inside the container into the shadowed NuGet cache; later
    // --no-restore phases assume this succeeded.
    const restore = await runDotNetCommand(
        runner,
        ["restore", workspace],
        workspaceRoot,
    );
    if (restore.status !== 0) {
        return failed({
            notice: `dotnet: restore failed${label}: ${failureDetail({ result: restore })}`,
        });
    }
    // Fix mode: format writes. No-fix runs no mutation; verification below does
    // the whole check.
    if (mode === "fix") {
        const formatWrite = await runDotNetCommand(
            runner,
            ["format", workspace],
            workspaceRoot,
        );
        if (formatWrite.status !== 0) {
            return failed({
                notice: `dotnet: format failed${label}: ${failureDetail({
                    result: formatWrite,
                })}`,
            });
        }
    }
    return null;
}

/**
 * The single verification phase: formatting is clean, then build (no restore),
 * then test (no build, no restore). Runs once in the authoritative no-fix pass
 * (#65), never during repair. Returns the failed result, or null when clean.
 */
async function runVerifyPhase({
    runner,
    workspace,
    workspaceRoot,
    label = "",
}: {
    runner: Runner;
    workspace: string;
    workspaceRoot: string;
    /** Suffix naming the workspace when several are gated at once. */
    label?: string;
}): Promise<StepResult | null> {
    const formatCheck = await runDotNetCommand(
        runner,
        ["format", "--verify-no-changes", workspace],
        workspaceRoot,
    );
    if (formatCheck.status !== 0) {
        return failed({
            notice: `dotnet: format found diffs${label} (run with --fix)`,
        });
    }

    const build = await runDotNetCommand(
        runner,
        ["build", workspace, "--no-restore"],
        workspaceRoot,
    );
    if (build.status !== 0) {
        return failed({
            notice: `dotnet: build failed${label}: ${failureDetail({ result: build })}`,
        });
    }

    const test = await runDotNetCommand(
        runner,
        ["test", workspace, "--no-build", "--no-restore"],
        workspaceRoot,
    );
    if (test.status !== 0) {
        return failed({
            notice: `dotnet: test failed${label}: ${failureDetail({ result: test })}`,
        });
    }
    return null;
}

/**
 * Resolve the workspaces to gate: the declared list when `.defined.json` names
 * one, otherwise the single discovered solution or project.
 *
 * A declared workspace must be part of the git inventory — the scratch copy is
 * materialised from that list, so anything outside it cannot be restored or
 * built. Returns the failure step result rather than throwing: a stale entry is
 * the operator's config error, reported like any other finding.
 */
function resolveWorkspaces({
    configured,
    trackedFiles,
    workspaceRoot,
}: {
    configured: string[];
    trackedFiles: string[];
    workspaceRoot: string;
}): { workspaces: string[] } | { failure: StepResult } {
    const tracked = new Set(trackedFiles);
    const missing = configured.filter((workspace) => !tracked.has(workspace));
    if (missing.length > 0) {
        return {
            failure: failed({
                notice: `dotnet: declared workspace not in the git scope: ${missing.join(", ")}`,
            }),
        };
    }
    return {
        workspaces: configured.map((workspace) =>
            join(workspaceRoot, workspace),
        ),
    };
}

/**
 * Run the repair phase over every workspace: restore, then format. Returns the
 * first failure, naming its workspace when more than one is gated.
 */
async function runSetupPhases({
    runner,
    workspaces,
    workspaceRoot,
    mode,
}: {
    runner: Runner;
    workspaces: string[];
    workspaceRoot: string;
    mode: DotNetRunContext["mode"];
}): Promise<StepResult | null> {
    const named = workspaces.length > 1;
    for (const workspace of workspaces) {
        const failure = await runRestoreAndFormat({
            runner,
            workspace,
            workspaceRoot,
            mode,
            label: workspaceLabel({ workspace, workspaceRoot, named }),
        });
        if (failure !== null) {
            return failure;
        }
    }
    return null;
}

/** Run the authoritative verification over every workspace. */
async function runVerifyPhases({
    runner,
    workspaces,
    workspaceRoot,
}: {
    runner: Runner;
    workspaces: string[];
    workspaceRoot: string;
}): Promise<StepResult | null> {
    const named = workspaces.length > 1;
    for (const workspace of workspaces) {
        const failure = await runVerifyPhase({
            runner,
            workspace,
            workspaceRoot,
            label: workspaceLabel({ workspace, workspaceRoot, named }),
        });
        if (failure !== null) {
            return failure;
        }
    }
    return null;
}

/** The workspace's repo-relative path as a notice suffix, when worth naming. */
function workspaceLabel({
    workspace,
    workspaceRoot,
    named,
}: {
    workspace: string;
    workspaceRoot: string;
    named: boolean;
}): string {
    return named ? ` [${workspace.slice(workspaceRoot.length + 1)}]` : "";
}

/** What the pass covered: the discovered projects or the declared workspaces. */
function passSummary({
    configured,
    projectCount,
    workspaceCount,
}: {
    configured: string[] | undefined;
    projectCount: number;
    workspaceCount: number;
}): string {
    return configured === undefined
        ? `${projectCount} project(s)`
        : `${workspaceCount} workspace(s)`;
}

/** Skip reasons that apply before any workspace resolution. */
function dotnetSkip({
    config,
    configured,
    projectCount,
}: {
    config: DefinedConfig;
    configured: string[] | undefined;
    projectCount: number;
}): StepResult | null {
    if (config.dotnet?.disable === true) {
        return skipped({ notice: "dotnet: disabled by .defined.json" });
    }
    if (configured === undefined && projectCount === 0) {
        return skipped({
            notice: "dotnet: no tracked *.csproj/*.sln/*.slnx files",
        });
    }
    return null;
}

/**
 * The writable root the workspace commands run in: the repo for a write-capable
 * invocation, the shared scratch copy for a read-only no-fix pass. Restore,
 * build and test write obj/bin/TestResults, which a read-only /repo mount
 * cannot; the scratch is shared with the coverage step via ctx.scratch
 * (lib/scratch.mts) and materialised from the whole inventory, so a narrowed
 * content scope never starves a build.
 */
function resolveWorkspaceRoot({
    ctx,
    scratchFiles,
}: {
    ctx: DotNetRunContext;
    scratchFiles: string[];
}): string {
    if (ctx.mode !== "no-fix") {
        return ctx.repoRoot;
    }
    return ensureScratch({
        scratch: ctx.scratch,
        repoRoot: ctx.repoRoot,
        files: scratchFiles,
    });
}

/** The declared workspaces, or the single discovered one. */
function resolveWorkspaceList({
    configured,
    trackedFiles,
    workspaceRoot,
}: {
    configured: string[] | undefined;
    trackedFiles: string[];
    workspaceRoot: string;
}): { workspaces: string[] } | { failure: StepResult } {
    if (configured !== undefined) {
        return resolveWorkspaces({ configured, trackedFiles, workspaceRoot });
    }
    return {
        workspaces: [
            discoverWorkspace({
                repoRoot: workspaceRoot,
                workspaceEnv: process.env.TOOL_WORKSPACE,
                slnxFiles: trackedFiles.filter((f) => f.endsWith(".slnx")),
                slnFiles: trackedFiles.filter((f) => f.endsWith(".sln")),
                csprojFiles: trackedFiles.filter((f) => f.endsWith(".csproj")),
            }),
        ],
    };
}

/**
 * Run the .NET step over the discovered or declared workspaces. Repair (fix)
 * mode runs only restore + format; no-fix mode is the single authoritative
 * verification (format check, build, test) (#65). Returns skip when no .NET
 * files tracked; fail naming the failing phase and, when several workspaces are
 * gated, the workspace that failed.
 */
export async function runDotNetStep({
    ctx,
    trackedFiles,
    scratchFiles = trackedFiles,
    runner = run,
}: {
    ctx: DotNetRunContext;
    trackedFiles: string[];
    /** The whole git inventory the scratch copy is materialised from. */
    scratchFiles?: string[];
    runner?: Runner;
}): Promise<StepResult> {
    const config = await loadConfig({ repoRoot: ctx.repoRoot });
    const configured = config.dotnet?.workspaces;
    const dotnetFiles = filterDotNetFiles({ files: trackedFiles });
    const skip = dotnetSkip({
        config,
        configured,
        projectCount: dotnetFiles.length,
    });
    if (skip !== null) {
        return skip;
    }

    const workspaceRoot = resolveWorkspaceRoot({ ctx, scratchFiles });
    const resolved = resolveWorkspaceList({
        configured,
        trackedFiles,
        workspaceRoot,
    });
    if ("failure" in resolved) {
        return resolved.failure;
    }
    const { workspaces } = resolved;
    const summary = passSummary({
        configured,
        projectCount: dotnetFiles.length,
        workspaceCount: workspaces.length,
    });

    const setupFailure = await runSetupPhases({
        runner,
        workspaces,
        workspaceRoot,
        mode: ctx.mode,
    });
    if (setupFailure !== null) {
        return setupFailure;
    }
    // Repair ended with a clean mutation: report that, do not verify.
    if (ctx.mode === "fix") {
        return passed({
            notice: `dotnet: restored and formatted (${summary})`,
        });
    }

    const verifyFailure = await runVerifyPhases({
        runner,
        workspaces,
        workspaceRoot,
    });
    if (verifyFailure !== null) {
        return verifyFailure;
    }

    return passed({
        notice: `dotnet: format/build/test clean (${summary})`,
    });
}
