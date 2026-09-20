// runtime/lib/config-install.mts — decision #13: shared configs into the repo root.
//
// Installs a named set of shared config files from a source directory (the
// standards/ dir) into the target repo root. Raises-only: an identical
// existing file is a no-op; a *different* existing file is reported as drift
// and never overwritten — the repo may have tightened its own rules and is
// never silently downgraded. Absent files are installed. Only the files in
// `names` are copied, so the standards dir stays the single source of truth
// and unrelated files never leak into a consumer repo root.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readContentsOrEmpty } from "./agents-block.mts";

export type InstallStatus = "installed" | "unchanged" | "drift";
export type CheckStatus = "present" | "absent" | "drift";

export interface InstalledConfig {
    name: string;
    status: InstallStatus;
}

export interface CheckedConfig {
    name: string;
    status: CheckStatus;
}

/**
 * Install the named root configs from sourceDir into repoRoot. Raises-only:
 * absent files are written, identical files are left alone, and a *different*
 * existing file is reported as `drift` and never overwritten (the repo may
 * have tightened its own rules and is never silently downgraded). Drift does
 * not stop the pass — every named config is inspected — and the caller renders
 * it through the report contract.
 */
export async function installRootConfigs({
    sourceDir,
    names,
    repoRoot,
}: {
    sourceDir: string;
    names: string[];
    repoRoot: string;
}): Promise<InstalledConfig[]> {
    const results: InstalledConfig[] = [];
    for (const name of names) {
        const desired = await readFile(join(sourceDir, name), "utf8");
        const target = join(repoRoot, name);
        const existing = await readContentsOrEmpty({ filePath: target });
        if (existing === "") {
            await writeFile(target, desired);
            results.push({ name, status: "installed" });
        } else if (existing === desired) {
            results.push({ name, status: "unchanged" });
        } else {
            results.push({ name, status: "drift" });
        }
    }
    return results;
}

/**
 * Read-only counterpart of installRootConfigs: report each named config as
 * present (identical), absent or drifted without writing a byte. Used by
 * `verify` to detect bootstrap drift before the check pass.
 */
export async function checkRootConfigs({
    sourceDir,
    names,
    repoRoot,
}: {
    sourceDir: string;
    names: string[];
    repoRoot: string;
}): Promise<CheckedConfig[]> {
    const results: CheckedConfig[] = [];
    for (const name of names) {
        const desired = await readFile(join(sourceDir, name), "utf8");
        const existing = await readContentsOrEmpty({
            filePath: join(repoRoot, name),
        });
        if (existing === "") {
            results.push({ name, status: "absent" });
        } else if (existing === desired) {
            results.push({ name, status: "present" });
        } else {
            results.push({ name, status: "drift" });
        }
    }
    return results;
}
