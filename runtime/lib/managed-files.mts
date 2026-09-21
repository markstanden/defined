// runtime/lib/managed-files.mts — decision #13: shared files into a repo.
//
// Installs a named set of files from a source directory (the standards/ dir)
// into the target repo. Each file declares a mode (see FileMode):
//
// - `managed`: gate-owned plumbing that must match the image. An absent file
//   is installed, an identical file is a no-op, and a *differing* file is
//   overwritten by `comply` (a gate update propagates) and reported as drift
//   by `verify` (read-only — it cannot repair).
// - `seeded`: a house default. Installed only when absent; an existing copy
//   belongs to the repo — it is never overwritten and never checked, so a
//   project with its own rules keeps them.
//
// Absent files are installed, creating parent directories as needed. Only the
// listed files are copied, so standards/ stays the single source of truth and
// unrelated files never leak into a consumer repo.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readContentsOrEmpty } from "./agents-block.mts";

/**
 * How the gate treats an existing copy of a file. `managed` files are
 * gate-owned and must stay byte-identical to the image; `seeded` files are
 * defaults the repo may replace with its own.
 */
export type FileMode = "managed" | "seeded";
export type InstallStatus = "installed" | "unchanged" | "updated" | "kept";
export type CheckStatus = "present" | "absent" | "drift";

/**
 * A shared file: `source` relative to the standards dir, installed at
 * `target` relative to the repo root. The two differ where standards/ does not
 * mirror the repo layout — the gate workflow lives under standards/workflows/
 * but installs to .github/workflows/.
 */
export interface ManagedFile {
    source: string;
    target: string;
    mode: FileMode;
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
 * Install the named files from sourceDir into repoRoot, honouring each file's
 * mode. Absent files are written (creating any missing parent directories) and
 * identical files are left alone. A *different* existing file depends on the
 * mode: a managed file is overwritten and reported `updated` (the gate owns
 * it), while a seeded file is left in place and reported `kept` (the repo owns
 * it). No status stops the pass — every file is inspected — and the caller
 * renders the outcome through the report contract.
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
    for (const { source, target, mode } of files) {
        const desired = await readFile(join(sourceDir, source), "utf8");
        const destination = join(repoRoot, target);
        const existing = await readContentsOrEmpty({ filePath: destination });
        if (existing === "") {
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, desired);
            results.push({ name: target, status: "installed" });
        } else if (existing === desired) {
            results.push({ name: target, status: "unchanged" });
        } else if (mode === "managed") {
            await writeFile(destination, desired);
            results.push({ name: target, status: "updated" });
        } else {
            results.push({ name: target, status: "kept" });
        }
    }
    return results;
}

/**
 * Read-only counterpart of installManagedFiles: report each managed file as
 * present (identical), absent or drifted without writing a byte. Seeded files
 * are skipped entirely — a repo's own default is never gate business — so the
 * caller gates only on gate-owned files. Used by `verify` to detect bootstrap
 * drift before the check pass.
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
    for (const { source, target, mode } of files) {
        if (mode === "seeded") {
            continue;
        }
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
