// steps/workflow.mts — GitHub Actions workflows: actionlint + zizmor + gitleaks.
//
// Tools:    actionlint, zizmor, gitleaks (all required — missing = loud fail)
// Config:   .gitleaksignore at repo root (optional) — honoured via an explicit
//           --gitleaks-ignore-path pinned to the repo root, so the consumer's
//           fingerprint baseline survives regardless of CWD. zizmor runs at
//           its own default min-severity (informational): every finding it
//           reports fails.
// Fix:      none — these are check-only tools
//
// Detection: actionlint/zizmor run only when tracked workflow files exist
// (.github/workflows/*.yml, .github/workflows/*.yaml, .github/dependabot.yml).
// gitleaks always runs (scans the repo's git scope for secrets).
// The runner is injected so tests need no host binaries.
//
// gitleaks scope (decision: "gate scope = git scope"): gitleaks `dir` walks
// the filesystem and does not honour .gitignore (no flag as of 8.30.x), so a
// whole-tree scan flags secrets in gitignored files — a local `.env` with a
// real key would fail locally while CI (fresh checkout, no `.env`) stays
// green. The gate instead generates a config that keeps the default rules
// ([extend] useDefault) and allowlists exactly the repo's git-ignored paths
// (from `git status --ignored --porcelain`, anchored so an ignored `.env`
// cannot bleed onto a tracked `.env.example`). Effective scope = the same
// git content every other step sees.

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failed, passed, type StepResult } from "../lib/step-result.mts";
import { run } from "../../lib/proc.mts";

export interface WorkflowRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
}

type Runner = typeof run;

export const WORKFLOW_GLOBS = [
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    ".github/dependabot.yml",
] as const;

export function filterWorkflowFiles({ files }: { files: string[] }): string[] {
    return files.filter((file) => {
        return (
            (file.startsWith(".github/workflows/") &&
                (file.endsWith(".yml") || file.endsWith(".yaml"))) ||
            file === ".github/dependabot.yml"
        );
    });
}

/** Escape a path for use as a regex literal (gitleaks allowlist paths are regexes). */
export function escapeRegexPath(path: string): string {
    return path.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/**
 * Parse `git status --porcelain --ignored` output into the repo's git-ignored
 * untracked paths. Ignored directories appear collapsed with a trailing slash
 * (`!! bin/`); ignored files appear bare (`!! .env`). Both are kept.
 */
export function parseIgnoredPaths({ status }: { status: string }): string[] {
    return status
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("!! "))
        .map((line) => line.slice(3).trim())
        .filter((path) => path !== "");
}

/**
 * Build a gitleaks config that keeps the default rules ([extend] useDefault)
 * and allowlists exactly the given ignored paths. Paths are anchored regexes
 * in TOML literal strings (single quotes, no escape processing) so regex
 * backslashes survive and an ignored `.env` never bleeds onto a tracked
 * `.env.example`. A directory (trailing `/`) is anchored as a prefix; a file
 * is anchored end-to-end.
 */
export function buildGitleaksConfig({
    ignoredPaths,
}: {
    ignoredPaths: string[];
}): string {
    if (ignoredPaths.length === 0) {
        // No [allowlist] section: an empty `paths = []` is rejected by gitleaks
        // ("[[allowlists]] must contain at least one check"). Just the default
        // rules, so the scan is unchanged.
        return "[extend]\nuseDefault = true\n";
    }
    const patterns = ignoredPaths.map((path) => {
        const escaped = escapeRegexPath(path);
        const anchored = path.endsWith("/") ? `^${escaped}` : `^${escaped}$`;
        return `'${anchored.replaceAll("'", "''")}'`;
    });
    const lines = [
        "[extend]",
        "useDefault = true",
        "",
        "[allowlist]",
        `paths = [${patterns.join(", ")}]`,
        "",
    ];
    return lines.join("\n");
}

/**
 * Write a gitleaks config allowlisting the given ignored paths to a temp file
 * and return its path. The config keeps the default rules via [extend]
 * useDefault, so allowlisting the repo's git-ignored set changes the scope,
 * never the rules.
 */
export async function writeGitleaksConfig({
    ignoredPaths,
    writeFileFn = writeFile,
}: {
    ignoredPaths: string[];
    writeFileFn?: typeof writeFile;
}): Promise<string> {
    const config = buildGitleaksConfig({ ignoredPaths });
    const configPath = join(tmpdir(), "defined-gitleaks.toml");
    await writeFileFn(configPath, config);
    return configPath;
}

/**
 * Explicit gitleaks ignore-path args. gitleaks reads the consumer's
 * `.gitleaksignore` fingerprint baseline from `--gitleaks-ignore-path`
 * (default ".", resolved against the process CWD). The gate pins it to the
 * repo root so the baseline is honoured regardless of CWD, and only when the
 * file exists (an absent path is not handed to the tool). The baseline
 * suppresses known-good findings; it never widens scope — the generated config
 * still allowlists exactly the repo's git-ignored paths.
 */
export function gitleaksIgnoreArgs({
    repoRoot,
    exists = existsSync,
}: {
    repoRoot: string;
    exists?: typeof existsSync;
}): string[] {
    return exists(join(repoRoot, ".gitleaksignore"))
        ? ["--gitleaks-ignore-path", repoRoot]
        : [];
}

/**
 * Run actionlint, zizmor on workflow files, and gitleaks on the whole repo.
 * Returns pass when all clean; fail naming the offending tool.
 * If no workflow files tracked, skips actionlint/zizmor but still runs gitleaks.
 */
export async function runWorkflowStep({
    ctx,
    trackedFiles,
    runner = run,
    existsSyncFn = existsSync,
}: {
    ctx: WorkflowRunContext;
    trackedFiles: string[];
    runner?: Runner;
    existsSyncFn?: typeof existsSync;
}): Promise<StepResult> {
    const workflowFiles = filterWorkflowFiles({ files: trackedFiles });

    if (workflowFiles.length > 0) {
        const actionlint = runner({
            cmd: "actionlint",
            args: workflowFiles,
            cwd: ctx.repoRoot,
        });
        if (actionlint.status !== 0) {
            return failed({
                notice: `workflow: actionlint failed: ${actionlint.stderr.trim() || actionlint.stdout.trim()}`,
            });
        }

        const zizmor = runner({
            cmd: "zizmor",
            // No --min-severity: zizmor's own default (informational) applies,
            // so nothing is silently filtered out.
            args: ["--no-progress", ...workflowFiles],
            cwd: ctx.repoRoot,
        });
        if (zizmor.status !== 0) {
            return failed({
                notice: `workflow: zizmor failed: ${zizmor.stderr.trim() || zizmor.stdout.trim()}`,
            });
        }
    }

    // gitleaks always scans the repo's git scope. gitleaks `dir` walks the
    // filesystem and ignores .gitignore (no flag as of 8.30.x), so the gate
    // generates a config that keeps default rules and allowlists exactly the
    // repo's git-ignored paths — a local gitignored .env with a real secret
    // must not fail the gate while CI (no .env) stays green. The consumer's
    // `.gitleaksignore` fingerprint baseline is honoured via an explicit
    // --gitleaks-ignore-path pinned to the repo root (issue #24).
    const ignoredStatus = runner({
        cmd: "git",
        args: ["status", "--porcelain", "--ignored"],
        cwd: ctx.repoRoot,
    });
    if (ignoredStatus.status !== 0) {
        return failed({
            notice: `workflow: git status --ignored failed: ${ignoredStatus.stderr.trim() || ignoredStatus.stdout.trim()}`,
        });
    }
    const configPath = await writeGitleaksConfig({
        ignoredPaths: parseIgnoredPaths({ status: ignoredStatus.stdout }),
    });
    const gitleaks = runner({
        cmd: "gitleaks",
        args: [
            "dir",
            "--config",
            configPath,
            ...gitleaksIgnoreArgs({
                repoRoot: ctx.repoRoot,
                exists: existsSyncFn,
            }),
            ".",
        ],
        cwd: ctx.repoRoot,
    });
    if (gitleaks.status !== 0) {
        return failed({
            notice: `workflow: gitleaks found secrets: ${gitleaks.stdout.trim() || gitleaks.stderr.trim()}`,
        });
    }

    if (workflowFiles.length > 0) {
        return passed({
            notice: `workflow: actionlint/zizmor/gitleaks clean (${workflowFiles.length} workflow file(s))`,
        });
    }
    return passed({ notice: "workflow: no workflow files; gitleaks clean" });
}
