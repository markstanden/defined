// steps/node-checks.mts — Node/JS project checks: consumer lint/typecheck/test.
//
// Tools:    the consumer's own toolchain, restored by the `node-deps` step with
//           npm/yarn/pnpm — never the gate's global tools. Commands run through
//           `sh -c` with the package's node_modules/.bin (and the working
//           root's) prepended to PATH, so consumer-installed binaries win.
// Config:   .defined.json "node" — either "packages": [...] or the flat
//           "dir"/"install"/"checks" form. Absent/empty = step skips.
// Fix:      an optional per-check "fix" command runs first in fix mode only,
//           then the check always re-runs before reporting.
// No-fix:   runs against the /tmp scratch copy of the git scope (a read-only
//           verify cannot write node_modules into the repo) that `node-deps`
//           restored into, shared via ctx.scratch.
// Skip:     no "node" entry, or no checks declared.
//
// Dependency restore is owned by `node-deps`, which runs earlier in the pass;
// this step only resolves packages and runs checks, against the same working
// root. Scope is git's: package.json manifests come from the gate's tracked
// file list, so nested/monorepo packages are discovered without a filesystem
// walk. With exactly one tracked package.json, a flat config needs no "dir".
// The runner and existsSync are injected so tests need no host binaries.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
    failed,
    passed,
    skipped,
    type StepResult,
} from "../lib/step-result.mts";
import { resolveWorkingRoot, type Scratch } from "../lib/scratch.mts";
import { run } from "../../lib/proc.mts";
import {
    loadConfig,
    type NodeCheck,
    type NodePackageConfig,
} from "../lib/config.mts";
import {
    detail,
    packageLabel,
    resolvePackageDir,
    runWithLocalBin,
} from "../lib/node-packages.mts";

export interface NodeChecksRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the write-capable steps. */
    scratch?: Scratch;
}

type Runner = typeof run;
type Exists = typeof existsSync;

/** Run one check (with its fix in fix mode); null when it passes. */
function runCheck({
    mode,
    check,
    packageDir,
    workingRoot,
    runner,
    label,
}: {
    mode: "fix" | "no-fix";
    check: NodeCheck;
    packageDir: string;
    workingRoot: string;
    runner: Runner;
    label: string;
}): string | null {
    if (mode === "fix" && check.fix !== undefined) {
        const fixed = runWithLocalBin({
            runner,
            packageDir,
            workingRoot,
            command: check.fix,
        });
        if (fixed.status !== 0) {
            return `${label}: fix "${check.name}" failed: ${detail(fixed)}`;
        }
    }
    const result = runWithLocalBin({
        runner,
        packageDir,
        workingRoot,
        command: check.command,
    });
    return result.status === 0
        ? null
        : `${label}: ${check.name} failed: ${detail(result)}`;
}

/** Resolve and check one package; returns its failures and pass count. */
function runPackage({
    mode,
    pkg,
    workingRoot,
    trackedFiles,
    runner,
    existsSyncFn,
}: {
    mode: "fix" | "no-fix";
    pkg: NodePackageConfig;
    workingRoot: string;
    trackedFiles: string[];
    runner: Runner;
    existsSyncFn: Exists;
}): { failures: string[]; ran: number } {
    const resolved = resolvePackageDir({ files: trackedFiles, dir: pkg.dir });
    if ("error" in resolved) {
        return { failures: [resolved.error], ran: 0 };
    }
    const label = packageLabel(resolved.dir);
    const packageDir = join(workingRoot, resolved.dir);
    // node-deps owns restore; this guard keeps a missing/misconfigured package
    // from running checks in a directory that does not exist.
    if (!existsSyncFn(join(packageDir, "package.json"))) {
        return { failures: [`no package.json at ${label}`], ran: 0 };
    }

    const failures: string[] = [];
    let ran = 0;
    for (const check of pkg.checks) {
        const failure = runCheck({
            mode,
            check,
            packageDir,
            workingRoot,
            runner,
            label,
        });
        if (failure === null) {
            ran += 1;
        } else {
            failures.push(failure);
        }
    }
    return { failures, ran };
}

/**
 * Run the consumer's declared Node checks. Skips when `.defined.json` declares
 * none; otherwise runs each package's checks against the working root
 * `node-deps` restored, aggregating every failure into one notice.
 */
export async function runNodeChecksStep({
    ctx,
    trackedFiles,
    runner = run,
    readFileFn = readFile,
    existsSyncFn = existsSync,
}: {
    ctx: NodeChecksRunContext;
    trackedFiles: string[];
    runner?: Runner;
    readFileFn?: typeof readFile;
    existsSyncFn?: Exists;
}): Promise<StepResult> {
    const config = await loadConfig({ repoRoot: ctx.repoRoot, readFileFn });
    const packages = config.node?.packages ?? [];
    if (packages.length === 0) {
        return skipped({
            notice: "node-checks: no checks declared in .defined.json",
        });
    }

    // Same working root as node-deps: repo for fix, shared scratch for no-fix.
    const workingRoot = resolveWorkingRoot({
        mode: ctx.mode,
        repoRoot: ctx.repoRoot,
        scratch: ctx.scratch,
        files: trackedFiles,
    });

    const failures: string[] = [];
    let ran = 0;
    for (const pkg of packages) {
        const outcome = runPackage({
            mode: ctx.mode,
            pkg,
            workingRoot,
            trackedFiles,
            runner,
            existsSyncFn,
        });
        failures.push(...outcome.failures);
        ran += outcome.ran;
    }

    if (failures.length > 0) {
        return failed({ notice: `node-checks: ${failures.join("; ")}` });
    }
    return passed({
        notice: `node-checks: ${ran} check(s) passed across ${packages.length} package(s)`,
    });
}
