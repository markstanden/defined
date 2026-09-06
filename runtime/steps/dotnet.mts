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
// *.csproj, *.sln, or *.slnx file. Workspace discovery follows
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
import { run } from "../../lib/proc.mts";

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

async function runDotNetCommand(
    runner: Runner,
    args: string[],
    cwd: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
    return runner({ cmd: "dotnet", args, cwd });
}

/**
 * Run dotnet format, build, test over the discovered workspace.
 * Restore always runs first: the container's NuGet cache is shadowed by a
 * named volume (decision #3), so build/test cannot assume a host restore.
 * Returns skip when no .NET files tracked; fail naming the failing phase.
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

    // Restore inside the container into the shadowed NuGet cache; later
    // --no-restore phases assume this succeeded.
    const restore = await runDotNetCommand(
        runner,
        ["restore", workspace],
        workspaceRoot,
    );
    if (restore.status !== 0) {
        return failed({
            notice: `dotnet: restore failed: ${restore.stderr.trim()}`,
        });
    }

    // Fix mode: format (write) then verify; check mode: verify only.
    if (ctx.mode === "fix") {
        const formatWrite = await runDotNetCommand(
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

    // Always verify formatting is clean.
    const formatCheck = await runDotNetCommand(
        runner,
        ["format", "--verify-no-changes", workspace],
        workspaceRoot,
    );
    if (formatCheck.status !== 0) {
        return failed({
            notice: "dotnet: format found diffs (run with --fix)",
        });
    }

    const build = await runDotNetCommand(
        runner,
        ["build", workspace, "--no-restore"],
        workspaceRoot,
    );
    if (build.status !== 0) {
        return failed({
            notice: `dotnet: build failed: ${build.stderr.trim()}`,
        });
    }

    const test = await runDotNetCommand(
        runner,
        ["test", workspace, "--no-build", "--no-restore"],
        workspaceRoot,
    );
    if (test.status !== 0) {
        return failed({
            notice: `dotnet: test failed: ${test.stdout.trim() || test.stderr.trim()}`,
        });
    }

    return passed({
        notice: `dotnet: format/build/test clean (${dotnetFiles.length} project(s))`,
    });
}
