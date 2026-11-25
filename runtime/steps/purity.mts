// steps/purity.mts — opt-in purity and CQS contracts.
//
// One read-only pass over the repo's git scope, using the baked ESLint engine
// and parser with runtime/config/purity.config.mjs. The consumer's own ESLint
// config, ignores, rules, inline disable comments and restored dependencies are
// deliberately out of the loop: `.defined.json` "purity" is the only switch,
// and "eslint": { "disable": true } does not turn this check off.
//
// Public surface:
//   runPurityStep({ ctx, trackedFiles, reviewFiles, runner }) — skip, pass, fail
//     or error
//   purityVerdict({ result, selected, repoRoot }) — classify one ESLint run
//
// Fix mode skips the step: it is a policy check, never a repair pass. A missing
// declaration skips before any parser work. A stale selector, or one pointing
// outside the declared content scope, is an execution error, not a silent pass.
// A `scan --files` run judges exactly the named JS/TS files under the same
// declared policy; config selectors are validated against the whole inventory,
// because a review selection is not a content scope. Findings carry the stable
// rule id, file, line, column and an actionable message.

import { relative } from "node:path";

import { gateConfigPath } from "../lib/config-path.mts";
import { loadConfig } from "../lib/config.mts";
import { hasJsTsExtension } from "../lib/js-files.mts";
import {
    purityPolicyEnv,
    selectPurityPolicy,
    type PurityPolicy,
} from "../lib/purity.mts";
import {
    errored,
    failed,
    passed,
    skipped,
    type StepDiagnostic,
    type StepResult,
} from "../lib/step-result.mts";
import { run, type CommandResult } from "../../lib/proc.mts";

export interface PurityRunContext {
    /** Purity is a policy check: it runs in the no-fix verification pass only. */
    mode: "fix" | "no-fix";
    /** Repo root the checkout was mounted at. */
    repoRoot: string;
}

type Runner = typeof run;

/** The rule ids this step may report. */
export const PURITY_RULES = new Set([
    "defined/pure-module",
    "defined/cqs-command",
    "defined/cqs-query",
    "defined/cqs-targets",
]);

interface PurityMessage {
    ruleId?: unknown;
    severity?: unknown;
    fatal?: unknown;
    line?: unknown;
    column?: unknown;
    message?: unknown;
}

interface PurityFileResult {
    filePath?: unknown;
    messages?: unknown;
}

interface PurityFinding {
    file: string;
    line: number;
    column: number;
    rule: string;
    message: string;
}

/** Deterministic code-unit ordering (never the ambient locale). */
function compareStrings(left: string, right: string): number {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

/** The sorted, deduped file list one run needs a verdict for. */
function selectedFiles(policy: PurityPolicy): string[] {
    return [...new Set([...policy.pure, ...Object.keys(policy.cqs)])].sort(
        compareStrings,
    );
}

/**
 * The files one run needs a verdict for: the policy's own files on a
 * whole-repository run, or the supported named files of a `scan --files`
 * selection.
 */
function judgeFiles({
    policy,
    reviewFiles,
}: {
    policy: PurityPolicy;
    reviewFiles?: readonly string[];
}): string[] {
    if (reviewFiles === undefined) {
        return selectedFiles(policy);
    }
    return [...new Set(reviewFiles)]
        .filter((file) => hasJsTsExtension({ file }))
        .sort(compareStrings);
}

/**
 * An empty judge list: a policy that selects nothing is a configuration error,
 * while a selection with no supported file is a clean skip, like shell and yaml
 * on a selection with none of their files.
 */
function emptyJudgeResult({
    reviewFiles,
}: {
    reviewFiles?: readonly string[];
}): StepResult {
    return reviewFiles === undefined
        ? errored({ message: "purity: policy selected no files" })
        : skipped({ notice: "purity: no JS/TS file in the selection" });
}

/** One line from a caught value, never a raw stack. */
function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** First non-empty line of a result's output, for a one-line error. */
function firstLine({ result }: { result: CommandResult }): string {
    const text =
        [result.stderr, result.stdout]
            .map((stream) => stream.trim())
            .find((stream) => stream !== "") ?? "no output";
    return text.split("\n")[0] ?? "";
}

function repoPath({
    repoRoot,
    file,
}: {
    repoRoot: string;
    file: string;
}): string {
    return relative(repoRoot, file).replaceAll("\\", "/");
}

/** Parse ESLint's JSON array; null when the output is not a result array. */
function parseResults({
    stdout,
}: {
    stdout: string;
}): PurityFileResult[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return null;
    }
    return Array.isArray(parsed) ? (parsed as PurityFileResult[]) : null;
}

function toFinding({
    file,
    message,
}: {
    file: string;
    message: PurityMessage;
}): PurityFinding {
    return {
        file,
        line: typeof message.line === "number" ? message.line : 0,
        column: typeof message.column === "number" ? message.column : 0,
        rule: typeof message.ruleId === "string" ? message.ruleId : "unknown",
        message: typeof message.message === "string" ? message.message : "",
    };
}

/** One execution error naming the file and location ESLint reported. */
function messageError({
    file,
    message,
    text,
}: {
    file: string;
    message: PurityMessage;
    text: string;
}): StepResult {
    return errored({
        message: text,
        file,
        line: typeof message.line === "number" ? message.line : 0,
        column: typeof message.column === "number" ? message.column : 0,
    });
}

/** A message that is not a per-file verdict: fatal, warning or foreign rule. */
function messageProblem({
    file,
    message,
}: {
    file: string;
    message: PurityMessage;
}): StepResult | null {
    const text = typeof message.message === "string" ? message.message : "";
    if (message.fatal === true) {
        return messageError({
            file,
            message,
            text: `purity: parse error in "${file}": ${text}`,
        });
    }
    if (message.severity === 1) {
        return messageError({
            file,
            message,
            text: `purity: eslint reported a warning in "${file}": ${text}`,
        });
    }
    if (message.severity !== 2) {
        return null;
    }
    if (
        typeof message.ruleId !== "string" ||
        !PURITY_RULES.has(message.ruleId)
    ) {
        return messageError({
            file,
            message,
            text: `purity: unexpected eslint message in "${file}": ${text}`,
        });
    }
    return null;
}

/** Fold one file's messages into findings, returning a problem when not a verdict. */
function collectFile({
    fileResult,
    repoRoot,
    findings,
    seen,
}: {
    fileResult: PurityFileResult;
    repoRoot: string;
    findings: PurityFinding[];
    seen: Set<string>;
}): StepResult | null {
    if (typeof fileResult.filePath !== "string") {
        return null;
    }
    const file = repoPath({ repoRoot, file: fileResult.filePath });
    seen.add(file);
    if (!Array.isArray(fileResult.messages)) {
        return errored({
            message: `purity: malformed eslint result for "${file}" (no messages array)`,
        });
    }
    for (const message of fileResult.messages as PurityMessage[]) {
        const problem = messageProblem({ file, message });
        if (problem !== null) {
            return problem;
        }
        if (message.severity === 2) {
            findings.push(toFinding({ file, message }));
        }
    }
    return null;
}

/**
 * Classify one ESLint run: findings fail with stable diagnostics, and anything
 * that is not a per-file verdict (crash, parse error, ignored file, unexpected
 * warning/rule) is an execution error — never a pass.
 */
export function purityVerdict({
    result,
    selected,
    repoRoot,
}: {
    result: CommandResult;
    selected: string[];
    repoRoot: string;
}): StepResult {
    if (result.status !== 0 && result.status !== 1) {
        return errored({
            message: `purity: eslint failed: ${firstLine({ result })}`,
        });
    }
    const raw = parseResults({ stdout: result.stdout });
    if (raw === null) {
        return errored({
            message: `purity: unreadable eslint JSON output: ${firstLine({ result })}`,
        });
    }
    const findings: PurityFinding[] = [];
    const seen = new Set<string>();
    for (const fileResult of raw) {
        const problem = collectFile({ fileResult, repoRoot, findings, seen });
        if (problem !== null) {
            return problem;
        }
    }
    const missing = selected.find((file) => !seen.has(file));
    if (missing !== undefined) {
        return errored({
            message: `purity: no eslint verdict for "${missing}" (the file was ignored or not parsed)`,
        });
    }
    return verdict({ findings, selected, result });
}

/** The pass/fail verdict once every selected file has a clean parsed verdict. */
function verdict({
    findings,
    selected,
    result,
}: {
    findings: PurityFinding[];
    selected: string[];
    result: CommandResult;
}): StepResult {
    if (findings.length === 0) {
        if (result.status !== 0) {
            return errored({
                message: `purity: eslint failed without findings: ${firstLine({ result })}`,
            });
        }
        return passed({ notice: `purity: ${selected.length} file(s) clean` });
    }
    const errors: StepDiagnostic[] = findings.map((finding) => ({
        kind: "finding",
        file: finding.file,
        line: finding.line,
        column: finding.column,
        rule: finding.rule,
        message: finding.message,
    }));
    return failed({
        notice: `purity: ${findings.length} finding(s)`,
        errors,
    });
}

/**
 * Run the opt-in purity/CQS policy. Skips in fix mode and when `.defined.json`
 * declares nothing; otherwise selects the gated files, runs one baked ESLint
 * pass with the policy in the environment, and classifies the result.
 */
export async function runPurityStep({
    ctx,
    trackedFiles,
    scratchFiles = trackedFiles,
    reviewFiles,
    runner = run,
}: {
    ctx: PurityRunContext;
    /** The content-check scope: the files a whole-repository run judges. */
    trackedFiles: string[];
    /**
     * The whole git inventory, used to tell a stale selector or target from one
     * pointing outside the declared content scope and, on a `scan --files` run,
     * to validate the policy (a review selection is not a content scope).
     */
    scratchFiles?: string[];
    /**
     * `scan --files` only: the named files. ESLint judges exactly these, with
     * the declared policy still applying to any that it covers, instead of the
     * policy's own file list.
     */
    reviewFiles?: readonly string[];
    runner?: Runner;
}): Promise<StepResult> {
    if (ctx.mode === "fix") {
        return skipped({
            notice: "purity: read-only; checked in the verification pass",
        });
    }
    const config = await loadConfig({ repoRoot: ctx.repoRoot });
    if (config.purity === undefined) {
        return skipped({ notice: "purity: not declared in .defined.json" });
    }
    let policy: PurityPolicy;
    try {
        policy = selectPurityPolicy({
            config: config.purity,
            files: reviewFiles === undefined ? trackedFiles : scratchFiles,
            allFiles: scratchFiles,
        });
    } catch (err) {
        return errored({ message: errorMessage(err) });
    }
    const selected = judgeFiles({ policy, reviewFiles });
    if (selected.length === 0) {
        return emptyJudgeResult({ reviewFiles });
    }
    let result: CommandResult;
    try {
        result = await runner({
            cmd: "eslint",
            args: [
                "--no-config-lookup",
                "--config",
                gateConfigPath({ name: "purity.config.mjs" }),
                "--format",
                "json",
                "--no-inline-config",
                ...selected,
            ],
            cwd: ctx.repoRoot,
            env: {
                ...process.env,
                DEFINED_PURITY_POLICY: purityPolicyEnv({ policy }),
            },
        });
    } catch (err) {
        return errored({
            message: `purity: eslint could not run: ${errorMessage(err)}`,
        });
    }
    return purityVerdict({ result, selected, repoRoot: ctx.repoRoot });
}
