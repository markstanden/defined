// lib/node-packages.mts — shared Node package resolution and dependency restore.
//
// Both the `node-deps` step (which restores dependencies) and the `node-checks`
// step (which runs the consumer's checks) need to resolve package directories
// from the git-scoped file list and to run a shell command with the package's
// local binaries first. This module is the single source of truth for that
// plumbing, so the two steps agree on where a package lives and how it is
// restored.
//
// Restore location follows the pass mode: the repo in fix mode, the shared
// /tmp scratch copy in no-fix (a read-only verify cannot write node_modules
// into the checkout). Callers resolve the working root once via
// lib/scratch.mts and pass it in, so formatting, checks and coverage all use
// the same directory (issue #40).
//
// Package manifests come from the gate's tracked file list, so nested and
// monorepo packages are discovered without a filesystem walk. With exactly one
// tracked package.json, a flat config needs no `dir`. Several manifests
// without an explicit `dir` fail loudly rather than guessing.
// The runner and existsSync are injected so tests need no host binaries.

import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { run, failureDetail, type CommandResult } from "../../lib/proc.mts";
import { hasConsumerPrettierConfig } from "./prettier-config.mts";
import { hasConsumerEslintConfig } from "./eslint-config.mts";

type Runner = typeof run;
type Exists = typeof existsSync;

/** Lockfile → default dependency-restore command. */
export const LOCKFILE_INSTALLS = [
    ["package-lock.json", "npm ci"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
] as const;

/** A package the gate may restore: its directory and optional install command. */
export interface RestoreTarget {
    /** Package directory relative to the repo root; `""` is the repo root. */
    dir?: string;
    /** Restore command; `false` skips restore; absent auto-detects. */
    install?: string | false;
}

/** Tracked package.json manifests at any depth, one entry per manifest. */
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

/** The tracked lockfile a package's default install freezes, if any. */
export type DetectedLockfile = (typeof LOCKFILE_INSTALLS)[number];

function detectedLockfile({
    packageDir,
    exists,
}: {
    packageDir: string;
    exists?: Exists;
}): DetectedLockfile | undefined {
    for (const entry of LOCKFILE_INSTALLS) {
        if (exists(join(packageDir, entry[0]))) {
            return entry;
        }
    }
    return undefined;
}

/** Default restore command from the package's lockfile (npm fallback). */
export function defaultInstall({
    packageDir,
    exists = existsSync,
}: {
    packageDir: string;
    exists?: Exists;
}): string {
    return detectedLockfile({ packageDir, exists })?.[1] ?? "npm install";
}

/** Human label for a resolved package directory (`""` is the repo root). */
export function packageLabel(dir: string): string {
    return dir === "" ? "." : dir;
}

/** Run a shell command with the package's local binaries ahead of PATH. */
export async function runWithLocalBin({
    runner,
    packageDir,
    workingRoot,
    command,
}: {
    runner: Runner;
    packageDir: string;
    workingRoot: string;
    command: string;
}): Promise<CommandResult> {
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
export function detail(result: CommandResult): string {
    return failureDetail({ result });
}

/**
 * The packages to restore for a pass: every declared package, plus the repo
 * root when a consumer Prettier or ESLint config is tracked and the root is
 * not already declared. A root restore is what makes a config-declared plugin
 * resolve on a fresh checkout (issue #40 / #63): prettier and eslint both
 * resolve plugins relative to the config file at the repo root. A declared
 * root (even `install: false`) wins, so an explicit opt-out is honoured, and a
 * disabled ESLint step never forces an ESLint-only root restore.
 *
 * Targets are deduplicated by their resolved package directory, so two
 * declarations for the same package (e.g. an explicit `""` plus an auto-added
 * root) restore once.
 */
export function packagesToRestore({
    declared,
    trackedFiles,
    eslintEnabled = true,
}: {
    declared: RestoreTarget[];
    trackedFiles: string[];
    /** False when `.defined.json` disables the ESLint step. */
    eslintEnabled?: boolean;
}): RestoreTarget[] {
    const result = [...declared];
    const rootDeclared = declared.some((pkg) => pkg.dir === "");
    const configTriggersRoot =
        hasConsumerPrettierConfig({ files: trackedFiles }) ||
        (eslintEnabled && hasConsumerEslintConfig({ files: trackedFiles }));
    if (
        !rootDeclared &&
        trackedFiles.includes("package.json") &&
        configTriggersRoot
    ) {
        result.push({ dir: "" });
    }
    return dedupeByResolvedDir({ targets: result, trackedFiles });
}

/** Keep the first target for each resolved package directory. */
function dedupeByResolvedDir({
    targets,
    trackedFiles,
}: {
    targets: RestoreTarget[];
    trackedFiles: string[];
}): RestoreTarget[] {
    const seen = new Set<string>();
    const result: RestoreTarget[] = [];
    for (const target of targets) {
        const resolved = resolvePackageDir({
            files: trackedFiles,
            dir: target.dir,
        });
        if ("error" in resolved) {
            // Unresolvable targets are kept so restore reports the error.
            result.push(target);
            continue;
        }
        if (seen.has(resolved.dir)) {
            continue;
        }
        seen.add(resolved.dir);
        result.push(target);
    }
    return result;
}

/**
 * Do the manifest and lockfile bytes match between the warm tree's root and
 * the working root? A frozen-lockfile install is deterministic, so byte-equal
 * inputs mean the warm tree is what an install would produce (#67).
 */
function manifestsMatch({
    warmDir,
    workDir,
    lockfile,
}: {
    warmDir: string;
    workDir: string;
    lockfile: string;
}): boolean {
    for (const name of ["package.json", lockfile]) {
        try {
            if (
                !readFileSync(join(warmDir, name)).equals(
                    readFileSync(join(workDir, name)),
                )
            ) {
                return false;
            }
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * Try to satisfy one package from the warm tree instead of reinstalling it:
 * only an auto-detected frozen-lockfile install qualifies (a declared install
 * command and the no-lockfile npm fallback are nondeterministic), and the
 * manifest + lockfile bytes must match between the two roots. Reuse is a copy
 * into the working root — or nothing at all when the working root *is* the
 * warm root. A failed copy (the source can vanish mid-copy under a concurrent
 * rebuild) reports false and the caller reinstalls (#67).
 */
function reuseWarmTree({
    warmRoot,
    workingRoot,
    dir,
    install,
    existsSyncFn,
    copyFn,
}: {
    warmRoot: string | undefined;
    workingRoot: string;
    dir: string;
    install: string | false | undefined;
    existsSyncFn: Exists;
    copyFn: typeof cpSync;
}): boolean {
    if (warmRoot === undefined || install !== undefined) {
        return false;
    }
    const lock = detectedLockfile({
        packageDir: join(warmRoot, dir),
        exists: existsSyncFn,
    });
    if (
        lock === undefined ||
        !manifestsMatch({
            warmDir: join(warmRoot, dir),
            workDir: join(workingRoot, dir),
            lockfile: lock[0],
        })
    ) {
        return false;
    }
    if (workingRoot === warmRoot) {
        return true;
    }
    try {
        copyFn(
            join(warmRoot, dir, "node_modules"),
            join(workingRoot, dir, "node_modules"),
            { recursive: true },
        );
        return true;
    } catch {
        return false;
    }
}

/** What became of one restore target. */
type RestoreVerdict = "restored" | "reused" | "skipped";

/**
 * Restore one resolved package: warm reuse first (see reuseWarmTree), then the
 * install command with local binaries ahead of PATH. A `failure` string is a
 * finding; `skipped` without one is a legitimate no-op (install: false).
 */
async function restoreOnePackage({
    pkg,
    dir,
    workingRoot,
    runner,
    existsSyncFn,
    warmRoot,
    copyFn,
}: {
    pkg: RestoreTarget;
    dir: string;
    workingRoot: string;
    runner: Runner;
    existsSyncFn: Exists;
    warmRoot: string | undefined;
    copyFn: typeof cpSync;
}): Promise<{ verdict: RestoreVerdict; failure?: string }> {
    const label = packageLabel(dir);
    const packageDir = join(workingRoot, dir);
    if (!existsSyncFn(join(packageDir, "package.json"))) {
        return { verdict: "skipped", failure: `no package.json at ${label}` };
    }
    if (pkg.install === false) {
        return { verdict: "skipped" };
    }
    if (
        reuseWarmTree({
            warmRoot,
            workingRoot,
            dir,
            install: pkg.install,
            existsSyncFn,
            copyFn,
        })
    ) {
        return { verdict: "reused" };
    }
    const command =
        pkg.install ?? defaultInstall({ packageDir, exists: existsSyncFn });
    const result = await runWithLocalBin({
        runner,
        packageDir,
        workingRoot,
        command,
    });
    if (result.status !== 0) {
        return {
            verdict: "skipped",
            failure: `${label}: install failed: ${detail(result)}`,
        };
    }
    return { verdict: "restored" };
}

/**
 * Restore every package's dependencies in `workingRoot`. Each package is
 * resolved from the tracked list, its manifest checked, and its install
 * command (declared, or auto-detected from the lockfile) run with local
 * binaries first. Returns the failure details, the number of packages
 * actually restored (a declared `install: false` is skipped, not a failure)
 * and the number satisfied from the warm tree instead (`warmRoot`, #67 —
 * see reuseWarmTree).
 */
export async function restoreNodePackages({
    workingRoot,
    trackedFiles,
    packages,
    runner,
    existsSyncFn = existsSync,
    warmRoot,
    copyFn = cpSync,
}: {
    workingRoot: string;
    trackedFiles: string[];
    packages: RestoreTarget[];
    runner: Runner;
    existsSyncFn?: Exists;
    /** The root a previous pass restored into; enables warm reuse (#67). */
    warmRoot?: string;
    copyFn?: typeof cpSync;
}): Promise<{ failures: string[]; restored: number; reused: number }> {
    const failures: string[] = [];
    const seen = new Set<string>();
    let restored = 0;
    let reused = 0;

    for (const pkg of packages) {
        const resolved = resolvePackageDir({
            files: trackedFiles,
            dir: pkg.dir,
        });
        if ("error" in resolved) {
            failures.push(resolved.error);
            continue;
        }
        if (seen.has(resolved.dir)) {
            continue;
        }
        seen.add(resolved.dir);
        const { verdict, failure } = await restoreOnePackage({
            pkg,
            dir: resolved.dir,
            workingRoot,
            runner,
            existsSyncFn,
            warmRoot,
            copyFn,
        });
        if (failure !== undefined) {
            failures.push(failure);
        }
        if (verdict === "reused") {
            reused += 1;
        }
        if (verdict === "restored") {
            restored += 1;
        }
    }

    return { failures, restored, reused };
}
