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

import { existsSync } from "node:fs";
import { join } from "node:path";

import { run, type CommandResult } from "../../lib/proc.mts";
import { hasConsumerPrettierConfig } from "./prettier-config.mts";

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
export function packageLabel(dir: string): string {
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
export function detail(result: CommandResult): string {
    return (
        [result.stdout, result.stderr]
            .map((stream) => stream.trim())
            .filter((stream) => stream !== "")
            .join("\n") || "no output"
    );
}

/**
 * The packages to restore for a pass: every declared package, plus the repo
 * root when a consumer Prettier config is tracked and the root is not already
 * declared. The root restore is what makes a config-declared plugin resolve on
 * a fresh checkout (issue #40): prettier resolves plugins relative to the
 * config file at the repo root. A declared root (even `install: false`) wins,
 * so an explicit opt-out is honoured.
 */
export function packagesToRestore({
    declared,
    trackedFiles,
}: {
    declared: RestoreTarget[];
    trackedFiles: string[];
}): RestoreTarget[] {
    const result = [...declared];
    const rootDeclared = declared.some((pkg) => pkg.dir === "");
    if (
        !rootDeclared &&
        trackedFiles.includes("package.json") &&
        hasConsumerPrettierConfig({ files: trackedFiles })
    ) {
        result.push({ dir: "" });
    }
    return result;
}

/**
 * Restore every package's dependencies in `workingRoot`. Each package is
 * resolved from the tracked list, its manifest checked, and its install
 * command (declared, or auto-detected from the lockfile) run with local
 * binaries first. Returns the failure details and the number of packages
 * actually restored (a declared `install: false` is skipped, not a failure).
 */
export function restoreNodePackages({
    workingRoot,
    trackedFiles,
    packages,
    runner,
    existsSyncFn = existsSync,
}: {
    workingRoot: string;
    trackedFiles: string[];
    packages: RestoreTarget[];
    runner: Runner;
    existsSyncFn?: Exists;
}): { failures: string[]; restored: number } {
    const failures: string[] = [];
    const seen = new Set<string>();
    let restored = 0;

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

        const label = packageLabel(resolved.dir);
        const packageDir = join(workingRoot, resolved.dir);
        if (!existsSyncFn(join(packageDir, "package.json"))) {
            failures.push(`no package.json at ${label}`);
            continue;
        }
        if (pkg.install === false) {
            continue;
        }

        const command =
            pkg.install ?? defaultInstall({ packageDir, exists: existsSyncFn });
        const result = runWithLocalBin({
            runner,
            packageDir,
            workingRoot,
            command,
        });
        if (result.status !== 0) {
            failures.push(`${label}: install failed: ${detail(result)}`);
            continue;
        }
        restored += 1;
    }

    return { failures, restored };
}
