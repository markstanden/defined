// steps/node-deps.mts — Node/JS dependency restore, shared by the node family.
//
// Tools:    the consumer's package manager (npm/yarn/pnpm), or a declared
//           install command — never the gate's global tools.
// Config:   .defined.json "node.packages" (or the flat "dir"/"install" form)
//           declares what to restore. Independently, when a consumer Prettier
//           config is tracked at the repo root, the root package is restored
//           too, so a config-declared plugin resolves on a fresh checkout
//           (issue #40) — prettier resolves plugins relative to that config.
// Fix:      restores into the repo (rw mount), where the node family then runs.
// No-fix:   restores into the /tmp scratch copy of the git scope, shared with
//           `node`, `node-checks` and `node-coverage` via ctx.scratch, so a
//           read-only verify never writes node_modules into the checkout.
// Skip:     nothing to restore (no declared packages and no consumer config).
// Reuse:    in no-fix the repo tree from the fix pass is reused when the
//           manifest + lockfile bytes still match (a frozen-lockfile install
//           is deterministic), so a warm volume means a copy instead of a
//           reinstall — see restoreNodePackages (#67).
//
// Restore is owned here so it happens once per pass, before formatting and
// checks. `node-checks` no longer installs; it runs the consumer's checks
// against what this step restored. Running this before `node` is not merely a
// reorder: restore and formatting resolve the same working root, so plugins
// load from where the dependencies actually are.
// The runner and existsSync are injected so tests need no host binaries.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
    failed,
    passed,
    skipped,
    type StepResult,
} from "../lib/step-result.mts";
import { resolveWorkingRoot, type Scratch } from "../lib/scratch.mts";
import { run } from "../../lib/proc.mts";
import { loadConfig } from "../lib/config.mts";
import {
    packagesToRestore,
    restoreNodePackages,
} from "../lib/node-packages.mts";

export interface NodeDepsRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the write-capable steps. */
    scratch?: Scratch;
}

type Runner = typeof run;
type Exists = typeof existsSync;

type RestoreSummary = {
    failures: string[];
    restored: number;
    reused: number;
};

/**
 * Present a restore summary: failures name every package; a pass distinguishes
 * warm reuse from fresh installs so cache hits are visible in the report (#67).
 */
function toStepResult({
    failures,
    restored,
    reused,
}: RestoreSummary): StepResult {
    if (failures.length > 0) {
        return failed({ notice: `node-deps: ${failures.join("; ")}` });
    }
    if (restored === 0 && reused === 0) {
        return skipped({ notice: "node-deps: no dependencies to restore" });
    }
    const counts = [
        ...(reused > 0 ? [`reused ${reused} warm tree(s)`] : []),
        ...(restored > 0 ? [`restored ${restored} package(s)`] : []),
    ];
    return passed({ notice: `node-deps: ${counts.join("; ")}` });
}

/**
 * Restore the consumer's Node dependencies for the pass. Skips cleanly when
 * there is nothing to restore; otherwise fails naming every package whose
 * restore failed.
 */
export async function runNodeDepsStep({
    ctx,
    trackedFiles,
    runner = run,
    readFileFn = readFile,
    existsSyncFn = existsSync,
}: {
    ctx: NodeDepsRunContext;
    trackedFiles: string[];
    runner?: Runner;
    readFileFn?: typeof readFile;
    existsSyncFn?: Exists;
}): Promise<StepResult> {
    const config = await loadConfig({ repoRoot: ctx.repoRoot, readFileFn });
    const packages = packagesToRestore({
        declared: config.node?.packages ?? [],
        trackedFiles,
        eslintEnabled: config.eslint?.disable !== true,
    });
    if (packages.length === 0) {
        return skipped({ notice: "node-deps: no dependencies to restore" });
    }

    const workingRoot = resolveWorkingRoot({
        mode: ctx.mode,
        repoRoot: ctx.repoRoot,
        scratch: ctx.scratch,
        files: trackedFiles,
    });
    return toStepResult(
        restoreNodePackages({
            workingRoot,
            trackedFiles,
            packages,
            runner,
            existsSyncFn,
            warmRoot: ctx.mode === "no-fix" ? ctx.repoRoot : undefined,
        }),
    );
}
