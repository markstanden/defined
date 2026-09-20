// steps/node-checks.mts — Node/JS project checks: consumer lint/typecheck/test.
//
// Tools:    the consumer's own toolchain, restored into the package with
//           npm/yarn/pnpm — never the gate's global tools. Commands run through
//           `sh -c` with the package's node_modules/.bin (and the working
//           root's) prepended to PATH, so consumer-installed binaries win.
// Config:   .defined.json "node" — either "packages": [...] or the flat
//           "dir"/"install"/"checks" form. Absent/empty = step skips.
// Fix:      an optional per-check "fix" command runs first in fix mode only,
//           then the check always re-runs before reporting.
// No-fix:   installs + runs against a /tmp scratch copy of the git scope (a
//           read-only verify cannot write node_modules into the repo), shared
//           with the node-coverage step via ctx.scratch.
// Skip:     no "node" entry, or no checks declared.
//
// Scope is git's: package.json manifests come from the gate's tracked file
// list, so nested/monorepo packages are discovered without a filesystem walk.
// With exactly one tracked package.json, a flat config needs no "dir" — the
// sole manifest's directory is used at any depth. Several manifests without an
// explicit "dir"/"packages" fail loudly rather than guessing.
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
import { ensureScratch, type Scratch } from "../lib/scratch.mts";
import { run, type CommandResult } from "../../lib/proc.mts";
import {
    loadConfig,
    type NodeCheck,
    type NodePackageConfig,
} from "../lib/config.mts";

export interface NodeChecksRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the write-capable steps. */
    scratch?: Scratch;
}

type Runner = typeof run;
type Exists = typeof existsSync;

/** Lockfile → default dependency-restore command. */
export const LOCKFILE_INSTALLS = [
    ["package-lock.json", "npm ci"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
] as const;

export function filterPackageJsons({ files }: { files: string[] }): string[] {
    return files.filter((file) => file.split("/").pop() === "package.json");
}

/**
 * Resolve a package's directory from the declared dir and the tracked file
 * list. An explicit dir (including `""` for the repo root) is used as-is; an
 * omitted dir uses the sole tracked package.json at any depth, or fails loudly
 * when there is none or more than one (a monorepo must name its packages).
 */
export function resolvePackageDir({
    files,
    dir,
}: {
    files: string[];
    dir: string | undefined;
}): { dir: string } | { error: string } {
    if (dir !== undefined) {
        return { dir };
    }
    const manifests = filterPackageJsons({ files });
    if (manifests.length === 0) {
        return { error: "no tracked package.json found" };
    }
    if (manifests.length > 1) {
        return {
            error: `multiple package.json tracked (${manifests.join(", ")}); set "dir" or "packages"`,
        };
    }
    return { dir: manifests[0]!.split("/").slice(0, -1).join("/") };
}

/** Default restore command from the package's lockfile (npm fallback). */
export function defaultInstall({
    packageDir,
    exists = existsSync,
}: {
    packageDir: string;
    exists?: Exists;
}): string {
    for (const [lockfile, command] of LOCKFILE_INSTALLS) {
        if (exists(join(packageDir, lockfile))) {
            return command;
        }
    }
    return "npm install";
}

/** Human label for a resolved package directory (`""` is the repo root). */
function packageLabel(dir: string): string {
    return dir === "" ? "." : dir;
}

/** Run a shell command with the package's local binaries ahead of PATH. */
export function runWithLocalBin({
    runner,
    packageDir,
    workingRoot,
    command,
}: {
    runner: Runner;
    packageDir: string;
    workingRoot: string;
    command: string;
}): CommandResult {
    const binDirs = [
        join(packageDir, "node_modules", ".bin"),
        join(workingRoot, "node_modules", ".bin"),
    ];
    return runner({
        cmd: "sh",
        args: ["-c", command],
        cwd: packageDir,
        env: {
            ...process.env,
            PATH: [...binDirs, process.env.PATH ?? ""].join(":"),
        },
    });
}

/** stdout first: test/build failures land there; stderr can be first-run noise. */
function detail(result: CommandResult): string {
    return (
        [result.stdout, result.stderr]
            .map((stream) => stream.trim())
            .filter((stream) => stream !== "")
            .join("\n") || "no output"
    );
}

/** Restore a package's dependencies; null when skipped or successful. */
function installPackage({
    pkg,
    packageDir,
    workingRoot,
    runner,
    existsSyncFn,
}: {
    pkg: NodePackageConfig;
    packageDir: string;
    workingRoot: string;
    runner: Runner;
    existsSyncFn: Exists;
}): string | null {
    const install =
        pkg.install === false
            ? null
            : (pkg.install ??
              defaultInstall({ packageDir, exists: existsSyncFn }));
    if (install === null) {
        return null;
    }
    const restored = runWithLocalBin({
        runner,
        packageDir,
        workingRoot,
        command: install,
    });
    return restored.status === 0 ? null : detail(restored);
}

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

/** Resolve, restore and check one package; returns its failures and pass count. */
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
    if (!existsSyncFn(join(packageDir, "package.json"))) {
        return { failures: [`no package.json at ${label}`], ran: 0 };
    }

    const installFailure = installPackage({
        pkg,
        packageDir,
        workingRoot,
        runner,
        existsSyncFn,
    });
    if (installFailure !== null) {
        return {
            failures: [`${label}: install failed: ${installFailure}`],
            ran: 0,
        };
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
 * none; otherwise restores each package's dependencies and runs its checks,
 * aggregating every failure into one agent-actionable notice.
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
    const packages: NodePackageConfig[] = config.node?.packages ?? [];
    if (packages.length === 0) {
        return skipped({
            notice: "node-checks: no checks declared in .defined.json",
        });
    }

    // Read-only verify cannot write node_modules into /repo, so no-fix works in
    // the shared scratch copy; fix mode works in the repo (named volume).
    const workingRoot =
        ctx.mode === "no-fix"
            ? ensureScratch({
                  scratch: ctx.scratch,
                  repoRoot: ctx.repoRoot,
                  files: trackedFiles,
              })
            : ctx.repoRoot;

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
