// steps/workflow.mts — GitHub Actions workflows: actionlint + zizmor + gitleaks.
//
// Tools:    actionlint, zizmor, gitleaks (all required — missing = loud fail)
// Config:   .gitleaksignore at repo root (optional) — honoured via an explicit
//           --gitleaks-ignore-path pinned to the repo root, so the consumer's
//           fingerprint baseline survives regardless of CWD. zizmor runs at
//           its own default min-severity (informational): every finding it
//           reports fails.
// Fix:      zizmor's *safe* autofixes (--fix) only. This is the repair pass
//           (#65): actionlint, zizmor's own check and gitleaks run once in the
//           authoritative no-fix verification pass, so a fix that leaves
//           breakage can never read as success. Unsafe fixes are deliberately
//           not applied — they encode design decisions (e.g. syntax a validator
//           may not yet accept), and the verification pass surfaces whatever
//           remains. actionlint and gitleaks stay check-only. The gate-managed
//           workflow is never rewritten.
//
// Detection: the workflow tools run only when tracked .github/ YAML exists.
// actionlint parses workflow *definitions* only (.github/workflows/*.yml|yaml)
// — handed dependabot.yml it false-fails; zizmor audits the wider set
// (workflow definitions plus .github/dependabot.yml), where its dependabot
// findings come from (issue #42). gitleaks always runs (scans the repo's git
// scope for secrets).
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
import {
    filterFixableFiles,
    filterWorkflowAuditFiles,
    filterWorkflowFiles,
} from "../lib/workflow-files.mts";

export interface WorkflowRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
}

type Runner = typeof run;

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
 * Repair pass: apply zizmor's *safe* autofixes before the checks run. The
 * output and exit status are discarded — the checks below are the verdict, so
 * a fix that leaves breakage can never read as success. Unsafe fixes are
 * never applied (they encode design decisions). The gate-managed workflow is
 * excluded: the gate owns it and repairs it upstream.
 */
function runZizmorFixes({
    ctx,
    trackedFiles,
    runner,
}: {
    ctx: WorkflowRunContext;
    trackedFiles: string[];
    runner: Runner;
}): void {
    if (ctx.mode !== "fix") {
        return;
    }
    const fixableFiles = filterFixableFiles({ files: trackedFiles });
    if (fixableFiles.length > 0) {
        runner({
            cmd: "zizmor",
            args: ["--fix", "--no-progress", ...fixableFiles],
            cwd: ctx.repoRoot,
        });
    }
}

/**
 * actionlint over the workflow definitions, zizmor over the audit set.
 * actionlint parses workflow *definitions* only — handed dependabot.yml it
 * false-fails — while zizmor audits the wider set (issue #42). No
 * --min-severity: zizmor's own default (informational) applies, so nothing is
 * silently filtered out. Findings go to stdout and tool-level errors to
 * stderr; preferring stderr would report "failed" with no findings at all.
 * Returns the failed result, or null when both are clean (or have no files).
 */
function runWorkflowTools({
    ctx,
    actionlintFiles,
    auditFiles,
    runner,
}: {
    ctx: WorkflowRunContext;
    actionlintFiles: string[];
    auditFiles: string[];
    runner: Runner;
}): StepResult | null {
    if (actionlintFiles.length > 0) {
        const actionlint = runner({
            cmd: "actionlint",
            args: actionlintFiles,
            cwd: ctx.repoRoot,
        });
        if (actionlint.status !== 0) {
            return failed({
                notice: `workflow: actionlint failed: ${actionlint.stdout.trim() || actionlint.stderr.trim()}`,
            });
        }
    }
    if (auditFiles.length > 0) {
        const zizmor = runner({
            cmd: "zizmor",
            args: ["--no-progress", ...auditFiles],
            cwd: ctx.repoRoot,
        });
        if (zizmor.status !== 0) {
            return failed({
                notice: `workflow: zizmor failed: ${zizmor.stdout.trim() || zizmor.stderr.trim()}`,
            });
        }
    }
    return null;
}

/**
 * gitleaks over the repo's git scope. gitleaks `dir` walks the filesystem and
 * ignores .gitignore (no flag as of 8.30.x), so the gate generates a config
 * that keeps default rules and allowlists exactly the repo's git-ignored
 * paths — a local gitignored .env with a real secret must not fail the gate
 * while CI (no .env) stays green. The consumer's `.gitleaksignore`
 * fingerprint baseline is honoured via an explicit --gitleaks-ignore-path
 * pinned to the repo root (issue #24). Returns the failed result, or null.
 */
async function runGitleaks({
    ctx,
    runner,
    existsSyncFn,
}: {
    ctx: WorkflowRunContext;
    runner: Runner;
    existsSyncFn: typeof existsSync;
}): Promise<StepResult | null> {
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
    return null;
}

/** The clean-pass notice, worded by what actually ran. */
function workflowVerdict({
    actionlintFiles,
    auditFiles,
}: {
    actionlintFiles: string[];
    auditFiles: string[];
}): StepResult {
    if (actionlintFiles.length > 0) {
        return passed({
            notice: `workflow: actionlint/zizmor/gitleaks clean (${auditFiles.length} file(s))`,
        });
    }
    if (auditFiles.length > 0) {
        // A dependabot-only run: zizmor audited it, actionlint did not run.
        return passed({
            notice: `workflow: zizmor/gitleaks clean (${auditFiles.length} audit file(s))`,
        });
    }
    return passed({ notice: "workflow: no workflow files; gitleaks clean" });
}

/**
 * Run actionlint, zizmor on workflow files, and gitleaks on the whole repo.
 * Repair (#65) runs zizmor --fix only; the authoritative no-fix pass runs the
 * checks (actionlint/zizmor/gitleaks) and judges their result. Returns pass
 * when clean; fail naming the offending tool. With no workflow files tracked,
 * verification skips actionlint/zizmor but still runs gitleaks.
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
    const auditFiles = filterWorkflowAuditFiles({ files: trackedFiles });
    const actionlintFiles = filterWorkflowFiles({ files: trackedFiles });

    runZizmorFixes({ ctx, trackedFiles, runner });

    // Repair: mutation only. The checks belong to the single authoritative
    // no-fix verification pass (#65).
    if (ctx.mode === "fix") {
        return passed({ notice: "workflow: applied zizmor autofixes" });
    }

    const toolFailure = runWorkflowTools({
        ctx,
        actionlintFiles,
        auditFiles,
        runner,
    });
    if (toolFailure !== null) {
        return toolFailure;
    }

    const leakFailure = await runGitleaks({ ctx, runner, existsSyncFn });
    if (leakFailure !== null) {
        return leakFailure;
    }
    return workflowVerdict({ actionlintFiles, auditFiles });
}
