// runtime/lib/managed-files.mts — decision #13: shared managed files into a repo.
//
// Installs a named set of managed files from a source directory (the
// standards/ dir) into the target repo. Raises-only: an identical existing
// file is a no-op; a *different* existing file is reported as drift and never
// overwritten — the repo may have tightened its own rules and is never
// silently downgraded. Absent files are installed, creating parent
// directories as needed. Only the listed files are copied, so standards/ stays
// the single source of truth and unrelated files never leak into a consumer
// repo.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readContentsOrEmpty } from "./agents-block.mts";

export type InstallStatus = "installed" | "unchanged" | "drift";
export type CheckStatus = "present" | "absent" | "drift";

/**
 * A managed file: `source` relative to the standards dir, installed at
 * `target` relative to the repo root. The two differ where standards/ does not
 * mirror the repo layout — the gate workflow lives under standards/workflows/
 * but installs to .github/workflows/.
 */
export interface ManagedFile {
    source: string;
    target: string;
}

export interface InstalledFile {
    /** Target path relative to the repo root (what the consumer sees). */
    name: string;
    status: InstallStatus;
}

export interface CheckedFile {
    /** Target path relative to the repo root (what the consumer sees). */
    name: string;
    status: CheckStatus;
}

/**
 * Install the named managed files from sourceDir into repoRoot. Raises-only:
 * absent files are written (creating any missing parent directories),
 * identical files are left alone, and a *different* existing file is reported
 * as `drift` and never overwritten (the repo may have tightened its own rules
 * and is never silently downgraded). Drift does not stop the pass — every file
 * is inspected — and the caller renders it through the report contract.
 */
export async function installManagedFiles({
    sourceDir,
    files,
    repoRoot,
}: {
    sourceDir: string;
    files: ManagedFile[];
    repoRoot: string;
}): Promise<InstalledFile[]> {
    const results: InstalledFile[] = [];
    for (const { source, target } of files) {
        const desired = await readFile(join(sourceDir, source), "utf8");
        const destination = join(repoRoot, target);
        const existing = await readContentsOrEmpty({ filePath: destination });
        if (existing === "") {
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, desired);
            results.push({ name: target, status: "installed" });
        } else if (existing === desired) {
            results.push({ name: target, status: "unchanged" });
        } else {
            results.push({ name: target, status: "drift" });
        }
    }
    return results;
}

/**
 * Read-only counterpart of installManagedFiles: report each managed file as
 * present (identical), absent or drifted without writing a byte. Used by
 * `verify` to detect bootstrap drift before the check pass.
 */
export async function checkManagedFiles({
    sourceDir,
    files,
    repoRoot,
}: {
    sourceDir: string;
    files: ManagedFile[];
    repoRoot: string;
}): Promise<CheckedFile[]> {
    const results: CheckedFile[] = [];
    for (const { source, target } of files) {
        const desired = await readFile(join(sourceDir, source), "utf8");
        const existing = await readContentsOrEmpty({
            filePath: join(repoRoot, target),
        });
        if (existing === "") {
            results.push({ name: target, status: "absent" });
        } else if (existing === desired) {
            results.push({ name: target, status: "present" });
        } else {
            results.push({ name: target, status: "drift" });
        }
    }
    return results;
}
