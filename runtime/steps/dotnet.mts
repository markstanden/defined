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
import { run, type CommandResult } from "../../lib/proc.mts";
import { loadConfig } from "../lib/config.mts";

export interface DotNetRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the dotnet + coverage steps. */
    scratch?: Scratch;
}

type Runner = typeof run;

export function filterDotNetFiles({ files }: { files: string[] }): string[] {
    return files.filter((file) => /\.(csproj|sln|slnx)$/u.test(file));
}

export interface DiscoverWorkspaceInput {
    repoRoot: string;
    workspaceEnv?: string;
    slnxFiles: string[];
    slnFiles: string[];
    csprojFiles: string[];
}

/**
 * Discover the .NET workspace to operate on.
 * Priority: explicit env → single .slnx → single .sln → single .csproj →
 * repo root. The csproj resolution matters: the CLI cannot operate on a bare
 * directory that merely *contains* a project, so a lone nested project must be
 * passed by path. Throws on multiple solutions, or multiple projects with no
 * solution, without explicit selection.
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
            `Multiple solution files found at repo root; use --workspace or TOOL_WORKSPACE: ${[
                ...slnxFiles,
                ...slnFiles,
            ].join(", ")}`,
        );
    }
    if (csprojFiles.length === 1) {
        return `${repoRoot}/${csprojFiles[0]!}`;
    }
    if (csprojFiles.length > 1) {
        throw new Error(
            `Multiple .csproj files with no solution; use --workspace or TOOL_WORKSPACE: ${csprojFiles.join(
                ", ",
            )}`,
        );
    }
    return repoRoot;
}

function runDotNetCommand(
    runner: Runner,
    args: string[],
    cwd: string,
): CommandResult {
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
}: {
    runner: Runner;
    workspace: string;
    workspaceRoot: string;
    mode: DotNetRunContext["mode"];
}): Promise<StepResult | null> {
    // Restore inside the container into the shadowed NuGet cache; later
    // --no-restore phases assume this succeeded.
    const restore = runDotNetCommand(
        runner,
        ["restore", workspace],
        workspaceRoot,
    );
    if (restore.status !== 0) {
        return failed({
            notice: `dotnet: restore failed: ${restore.stderr.trim()}`,
        });
    }
    // Fix mode: format writes. No-fix runs no mutation; verification below does
    // the whole check.
    if (mode === "fix") {
        const formatWrite = runDotNetCommand(
            runner,
            ["format", workspace],
            workspaceRoot,
        );
        if (formatWrite.status !== 0) {
            return failed({
                notice: `dotnet: format failed: ${formatWrite.stderr.trim()}`,
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
}: {
    runner: Runner;
    workspace: string;
    workspaceRoot: string;
}): Promise<StepResult | null> {
    const formatCheck = runDotNetCommand(
        runner,
        ["format", "--verify-no-changes", workspace],
        workspaceRoot,
    );
    if (formatCheck.status !== 0) {
        return failed({
            notice: "dotnet: format found diffs (run with --fix)",
        });
    }

    const build = runDotNetCommand(
        runner,
        ["build", workspace, "--no-restore"],
        workspaceRoot,
    );
    if (build.status !== 0) {
        return failed({
            notice: `dotnet: build failed: ${build.stderr.trim()}`,
        });
    }

    const test = runDotNetCommand(
        runner,
        ["test", workspace, "--no-build", "--no-restore"],
        workspaceRoot,
    );
    if (test.status !== 0) {
        return failed({
            notice: `dotnet: test failed: ${test.stdout.trim() || test.stderr.trim()}`,
        });
    }
    return null;
}

/**
 * Run the .NET step over the discovered workspace. Repair (fix) mode runs only
 * restore + format; no-fix mode is the single authoritative verification
 * (format check, build, test) (#65). Returns skip when no .NET files tracked;
 * fail naming the failing phase.
 */
export async function runDotNetStep({
    ctx,
    trackedFiles,
    runner = run,
}: {
    ctx: DotNetRunContext;
    trackedFiles: string[];
    runner?: Runner;
}): Promise<StepResult> {
    const config = await loadConfig({ repoRoot: ctx.repoRoot });
    if (config.dotnet?.disable === true) {
        return skipped({ notice: "dotnet: disabled by .defined.json" });
    }
    const dotnetFiles = filterDotNetFiles({ files: trackedFiles });
    if (dotnetFiles.length === 0) {
        return skipped({
            notice: "dotnet: no tracked *.csproj/*.sln/*.slnx files",
        });
    }

    const slnxFiles = trackedFiles.filter((f) => f.endsWith(".slnx"));
    const slnFiles = trackedFiles.filter((f) => f.endsWith(".sln"));
    const csprojFiles = trackedFiles.filter((f) => f.endsWith(".csproj"));
    // no-fix (verify/CI) runs against a scratch copy of the git scope under
    // /tmp: restore/build/test must write obj/bin/TestResults, which a
    // read-only /repo mount cannot. The scratch is shared with the coverage
    // step via ctx.scratch (lib/scratch.mts).
    const workspaceRoot =
        ctx.mode === "no-fix"
            ? ensureScratch({
                  scratch: ctx.scratch,
                  repoRoot: ctx.repoRoot,
                  files: trackedFiles,
              })
            : ctx.repoRoot;
    const workspace = discoverWorkspace({
        repoRoot: workspaceRoot,
        workspaceEnv: process.env.TOOL_WORKSPACE,
        slnxFiles,
        slnFiles,
        csprojFiles,
    });

    const setupFailure = await runRestoreAndFormat({
        runner,
        workspace,
        workspaceRoot,
        mode: ctx.mode,
    });
    if (setupFailure !== null) {
        return setupFailure;
    }
    // Repair ended with a clean mutation: report that, do not verify.
    if (ctx.mode === "fix") {
        return passed({
            notice: `dotnet: restored and formatted (${dotnetFiles.length} project(s))`,
        });
    }

    const verifyFailure = await runVerifyPhase({
        runner,
        workspace,
        workspaceRoot,
    });
    if (verifyFailure !== null) {
        return verifyFailure;
    }

    return passed({
        notice: `dotnet: format/build/test clean (${dotnetFiles.length} project(s))`,
    });
}
