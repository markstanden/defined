// steps/tofu.mts — OpenTofu: fmt, tflint, init, validate.
//
// Tools:    tofu (OpenTofu), tflint
// Config:   .defined.json "tofu.dirs" (optional) — explicit module directories;
//           absent means auto-discover the top-most tracked .tf directories.
//           tflint otherwise picks up the project's .tflint.hcl when present.
// Fix:      tofu fmt -write and tflint --fix rewrite, then the step re-verifies
//           — a fix that leaves diffs can never read as success
// No-fix:   runs in the shared /tmp scratch copy of the git scope: `tofu init`
//           writes .terraform/ and a lock file, which a read-only verify/CI
//           mount cannot host (same mechanism as the node/dotnet steps).
//
// Detection is sync and data-driven: activation = at least one tracked *.tf file.
// fmt is scoped to the tracked .tf files (git scope), never a recursive walk of
// the filesystem — that would descend into gitignored .terraform/modules copies.
// tflint/init/validate run once per module directory, so a monorepo module in a
// subdirectory (no root .tf) is actually checked, not silently skipped.
// The runner is injected so tests need no host binaries.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    failed,
    passed,
    skipped,
    type StepResult,
} from "../lib/step-result.mts";
import { resolveWorkingRoot, type Scratch } from "../lib/scratch.mts";
import { run } from "../../lib/proc.mts";
import { loadConfig } from "../lib/config.mts";

export interface TofuRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
    /** Shared scratch box (no-fix): init must write, so a ro verify needs a copy. */
    scratch?: Scratch;
}

type Runner = typeof run;

export function filterTofuFiles({ files }: { files: string[] }): string[] {
    return files.filter((file) => file.endsWith(".tf"));
}

/**
 * The module directories to lint/init/validate: every directory holding a
 * tracked .tf file, reduced to the top-most ones. The repo root (".") is always
 * kept as its own module; a deeper dir is dropped when it has a discovered
 * ancestor other than "." (its parent module already covers it). Sorted for
 * deterministic output.
 */
export function tfDirectories({ files }: { files: string[] }): string[] {
    const dirs = new Set<string>();
    for (const file of filterTofuFiles({ files })) {
        dirs.add(dirname(file));
    }
    return [...dirs].filter((dir) => !hasModuleAncestor({ dir, dirs })).sort();
}

/** True when `dir` sits below a discovered module dir other than the root. */
function hasModuleAncestor({
    dir,
    dirs,
}: {
    dir: string;
    dirs: Set<string>;
}): boolean {
    let parent = dirname(dir);
    while (parent !== "." && parent !== "/" && parent !== "") {
        if (dirs.has(parent)) {
            return true;
        }
        const next = dirname(parent);
        if (next === parent) {
            break;
        }
        parent = next;
    }
    return false;
}

function runTofuCommand(
    runner: Runner,
    args: string[],
    cwd: string,
): { status: number; stdout: string; stderr: string } {
    return runner({ cmd: "tofu", args, cwd });
}

function runTflintCommand(
    runner: Runner,
    args: string[],
    cwd: string,
): { status: number; stdout: string; stderr: string } {
    return runner({ cmd: "tflint", args, cwd });
}

/**
 * Lint, init and validate one module directory. Returns a failure notice naming
 * the directory, or null when the directory is clean.
 */
async function runModuleChecks({
    runner,
    cwd,
    dir,
    mode,
}: {
    runner: Runner;
    cwd: string;
    dir: string;
    mode: "fix" | "no-fix";
}): Promise<string | null> {
    // --init first so a project .tflint.hcl's plugins land in the plugin cache;
    // then lint. Exit 0 clean / 1 error / 2 issues found.
    const tflintInit = await runTflintCommand(runner, ["--init"], cwd);
    if (tflintInit.status !== 0) {
        return `tofu: tflint --init failed in ${dir}: ${tflintInit.stderr.trim()}`;
    }

    if (mode === "fix") {
        const tflintFix = await runTflintCommand(runner, ["--fix"], cwd);
        if (tflintFix.status === 1) {
            return `tofu: tflint --fix failed in ${dir}: ${tflintFix.stderr.trim()}`;
        }
    }

    const tflint = await runTflintCommand(runner, [], cwd);
    if (tflint.status !== 0) {
        return `tofu: tflint found issues in ${dir}:\n${tflint.stdout.trim()}`;
    }

    // -backend=false skips backend init (still fetches providers).
    const init = await runTofuCommand(runner, ["init", "-backend=false"], cwd);
    if (init.status !== 0) {
        return `tofu: init failed in ${dir}: ${init.stderr.trim()}`;
    }

    const validate = await runTofuCommand(runner, ["validate"], cwd);
    if (validate.status !== 0) {
        return `tofu: validate failed in ${dir}: ${validate.stdout.trim() || validate.stderr.trim()}`;
    }
    return null;
}

/**
 * Run tofu fmt, then tflint/init/validate per module directory.
 * Returns skip when no .tf files tracked; fail naming the failing phase/dir.
 */
export async function runTofuStep({
    ctx,
    trackedFiles,
    runner = run,
    readFileFn = readFile,
}: {
    ctx: TofuRunContext;
    trackedFiles: string[];
    runner?: Runner;
    readFileFn?: typeof readFile;
}): Promise<StepResult> {
    const tfFiles = filterTofuFiles({ files: trackedFiles });
    if (tfFiles.length === 0) {
        return skipped({ notice: "tofu: no tracked *.tf files" });
    }

    const workingRoot = resolveWorkingRoot({
        mode: ctx.mode,
        repoRoot: ctx.repoRoot,
        scratch: ctx.scratch,
        files: trackedFiles,
    });

    // fmt: exact git scope — the tracked .tf files, never a recursive walk.
    if (ctx.mode === "fix") {
        const fmtWrite = await runTofuCommand(
            runner,
            ["fmt", "-write", ...tfFiles],
            workingRoot,
        );
        if (fmtWrite.status !== 0) {
            return failed({
                notice: `tofu: fmt -write failed: ${fmtWrite.stderr.trim()}`,
            });
        }
    }

    const fmtCheck = await runTofuCommand(
        runner,
        ["fmt", "-check", ...tfFiles],
        workingRoot,
    );
    if (fmtCheck.status !== 0) {
        return failed({ notice: "tofu: fmt found diffs (run with --fix)" });
    }

    const config = await loadConfig({ repoRoot: ctx.repoRoot, readFileFn });
    const dirs = config.tofu?.dirs ?? tfDirectories({ files: trackedFiles });

    for (const dir of dirs) {
        const failure = await runModuleChecks({
            runner,
            cwd: join(workingRoot, dir),
            dir,
            mode: ctx.mode,
        });
        if (failure) {
            return failed({ notice: failure });
        }
    }

    return passed({
        notice: `tofu: fmt/tflint/init/validate clean (${tfFiles.length} file(s), ${dirs.length} module dir(s))`,
    });
}
