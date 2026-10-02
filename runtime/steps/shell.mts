// steps/shell.mts — shell script quality: shfmt + shellcheck.
//
// Tools:    shfmt (format), shellcheck (analysis)
// Config:   severity floor via raiseFloor; per-project ignores travel in
//           runtime/config/ when needed
// Fix:      shfmt -w rewrites, then the step re-checks before reporting —
//           a fix that leaves breakage can never read as success
//
// Detection is sync and data-driven: the orchestrator supplies the tracked
// file list (lib/git.mts); this module only filters it. The runner is
// injected so tests need no host binaries.

import {
    errored,
    failed,
    passed,
    skipped,
    type StepDiagnostic,
    type StepResult,
} from "../lib/step-result.mts";
import { run } from "../../lib/proc.mts";
import type { Severity } from "../lib/severities.mts";

// Floor 'style' = every shellcheck finding gates (error < warning < info
// < style). Raised from the original 'error' default per decision #18;
// floors only ever move up.
export const SHELLCHECK_DEFAULT_FLOOR: Severity = "style";

export interface ShellRunContext {
    mode: "fix" | "no-fix";
}

type Runner = typeof run;

export function filterShellScripts({ files }: { files: string[] }): string[] {
    return files.filter((file) => file.endsWith(".sh"));
}

/** `shfmt -l` lists one differing file per line. */
export function parseShfmtFiles({
    stdout,
}: {
    stdout: string;
}): StepDiagnostic[] {
    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((file) => file !== "")
        .map((file) => ({
            kind: "finding" as const,
            file,
            message: "not shfmt-formatted (run shfmt -w)",
        }));
}

// shellcheck's gcc format: `file:line:col: level: message [SCxxxx]`.
const SHELLCHECK_LINE = /^(.+?):(\d+):(\d+): ([a-z]+): (.*?) \[(SC\d+)\]$/u;

/** Every shellcheck finding as a structured diagnostic. */
export function parseShellcheck({ text }: { text: string }): StepDiagnostic[] {
    const errors: StepDiagnostic[] = [];
    for (const raw of text.split("\n")) {
        const match = SHELLCHECK_LINE.exec(raw.trim());
        if (match === null) {
            continue;
        }
        errors.push({
            kind: "finding",
            file: match[1]!,
            line: Number(match[2]),
            column: Number(match[3]),
            rule: match[6]!,
            message: match[5]!,
        });
    }
    return errors;
}

/**
 * Run shfmt + shellcheck over the tracked shell scripts. Returns skip with
 * a notice when none are present; fail naming the offending tool otherwise.
 */
export async function runShellStep({
    ctx,
    trackedFiles,
    runner = run,
    floor = SHELLCHECK_DEFAULT_FLOOR,
}: {
    ctx: ShellRunContext;
    trackedFiles: string[];
    runner?: Runner;
    floor?: Severity;
}): Promise<StepResult> {
    const scripts = filterShellScripts({ files: trackedFiles });
    if (scripts.length === 0) {
        return skipped({ notice: "shell: no tracked *.sh files" });
    }

    // Format first: in fix mode rewrite, then always verify clean.
    if (ctx.mode === "fix") {
        const fmt = runner({ cmd: "shfmt", args: ["-w", ...scripts] });
        if (fmt.status !== 0) {
            return errored({
                message: `shell: shfmt -w failed: ${fmt.stderr.trim()}`,
            });
        }
    }
    // -l lists the files still needing formatting (and exits 0 even when it
    // lists them); treat any listed file as the diff, and a nonzero exit as a
    // genuine shfmt execution failure.
    const check = runner({ cmd: "shfmt", args: ["-l", ...scripts] });
    if (check.status !== 0) {
        return errored({
            message: `shell: shfmt failed: ${check.stderr.trim()}`,
        });
    }
    const errors = parseShfmtFiles({ stdout: check.stdout });
    if (errors.length > 0) {
        return failed({
            notice: `shell: shfmt found formatting diffs (${errors.length} files)`,
            errors,
        });
    }

    const lint = runner({
        cmd: "shellcheck",
        args: ["-x", "-S", floor, "-f", "gcc", ...scripts],
    });
    if (lint.status !== 0) {
        const errors = parseShellcheck({
            text: `${lint.stdout}\n${lint.stderr}`,
        });
        if (errors.length === 0) {
            return failed({
                notice: `shell: shellcheck violations at or above '${floor}'`,
            });
        }
        return failed({
            notice: `shell: ${errors.length} shellcheck finding(s) at or above '${floor}'`,
            errors,
        });
    }

    return passed({ notice: `shell: ${scripts.length} file(s) clean` });
}
