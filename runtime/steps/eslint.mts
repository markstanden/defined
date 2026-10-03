// steps/eslint.mts — lint the git-scoped JS/TS with a flat config.
//
// Tools:    the baked `eslint` for the house config (which must resolve the
//           baked plugins), or the repo's restored `eslint` for a repo-owned
//           config (their version and plugins) — never a mix.
// Config:   runtime/config/eslint.config.mjs, selected with --config when the
//           repo has no config of its own; its plugins resolve in-image. A
//           repo-owned eslint.config.* runs instead, and the house default is
//           written beside it as eslint.config.defined.mjs (example sidecar).
//           `.defined.json` "eslint": { "disable": true } switches the step off;
//           "eslint": { "complexityMax": N | false } tunes the house config's
//           cyclomatic-complexity ceiling (forwarded as an env var).
// Fix:      --fix only. This is the repair pass (#65): the check runs once in
//           the authoritative no-fix verification pass, where a fix that leaves
//           findings can never read as success. --fix rewrites repo code (that
//           is what `comply` is for); the read-only `verify` pass never writes.
// No-fix:   runs against the shared /tmp scratch copy of the git scope, like
//           the node family, so a read-only verify cannot write into the repo.
// Skip:     no lintable tracked file, or the step is disabled by config.
//
// Scope is git's: trackedFiles filtered to the lintable extensions and passed
// to ESLint as explicit paths (--no-warn-ignored, so a config `ignores` match
// is a no-op rather than a warning). Output is requested as JSON so the notice
// can name a stable finding count instead of parsing a human formatter. The
// runner and notify sink are injected so tests need no host binaries and can
// capture the sidecar advisory.

import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import {
    errored,
    failed,
    passed,
    skipped,
    type StepDiagnostic,
    type StepResult,
} from "../lib/step-result.mts";
import { resolveWorkingRoot, type Scratch } from "../lib/scratch.mts";
import { run, type CommandResult } from "../../lib/proc.mts";
import { gateConfigPath } from "../lib/config-path.mts";
import { loadConfig, type DefinedConfig } from "../lib/config.mts";
import { hasConsumerEslintConfig } from "../lib/eslint-config.mts";
import { removeExample, writeExample } from "../lib/eslint-example.mts";
import { runWithLocalBin } from "../lib/node-packages.mts";

export interface EslintRunContext {
    /** Repair (fix) or authoritative verification (no-fix) — see comply #65. */
    mode: "fix" | "no-fix";
    /** Repo root the checkout was mounted at; scratch copies hang off it. */
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the write-capable steps. */
    scratch?: Scratch;
}

type Runner = typeof run;

/** Extensions the house config lints; mirrors LINT_FILES in that config. */
export const ESLINT_EXTENSIONS = [
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "mts",
    "cts",
    "tsx",
] as const;

/** Which config a pass runs: the baked house default or the repo's own. */
type ConfigKind = "house" | "repo";

const KIND_LABEL: Record<ConfigKind, string> = {
    house: "house config",
    repo: "repo config",
};

/** Keep only the tracked files ESLint can parse (the house config's set). */ export function filterEslintFiles({
    files,
}: {
    files: string[];
}): string[] {
    return files.filter((file) => {
        const dot = file.lastIndexOf(".");
        if (dot === -1) {
            return false;
        }
        const ext = file.slice(dot + 1);
        return (ESLINT_EXTENSIONS as readonly string[]).includes(ext);
    });
}

/**
 * Single-quote an argument for `sh -c` (the repo-config branch only): embed
 * each `'` as the classic close-escape-reopen sequence `'\''`. Exported for
 * tests — quoting is exactly where a silent character goes missing.
 */
export function shellQuote({ arg }: { arg: string }): string {
    return `'${arg.replaceAll("'", String.raw`'\''`)}'`;
}

function houseArgs({
    configPath,
    files,
    fix,
}: {
    configPath: string;
    files: string[];
    fix: boolean;
}): string[] {
    return [
        ...(fix ? ["--fix"] : []),
        "--config",
        configPath,
        "--format",
        "json",
        "--no-warn-ignored",
        ...files,
    ];
}

function repoCommand({
    files,
    fix,
}: {
    files: string[];
    fix: boolean;
}): string {
    return [
        "eslint",
        ...(fix ? ["--fix"] : []),
        "--format",
        "json",
        "--no-warn-ignored",
        ...files,
    ]
        .map((file) => shellQuote({ arg: file }))
        .join(" ");
}

/**
 * Run ESLint for one pass. The house config goes through the baked binary (its
 * plugins live in-image); a repo-owned config goes through the repo's restored
 * ESLint, so their version and plugins resolve as they expect.
 */
function invokeEslint({
    kind,
    configPath,
    files,
    fix,
    workingRoot,
    runner,
    env,
}: {
    kind: ConfigKind;
    configPath: string;
    files: string[];
    fix: boolean;
    workingRoot: string;
    runner: Runner;
    /** House-config override channel (complexityMax); undefined inherits. */
    env?: NodeJS.ProcessEnv;
}): CommandResult {
    if (kind === "house") {
        return runner({
            cmd: "eslint",
            args: houseArgs({ configPath, files, fix }),
            cwd: workingRoot,
            env,
        });
    }
    return runWithLocalBin({
        runner,
        packageDir: workingRoot,
        workingRoot,
        command: repoCommand({ files, fix }),
    });
}

interface EslintMessage {
    severity?: unknown;
    ruleId?: unknown;
    line?: unknown;
    column?: unknown;
    message?: unknown;
}

interface EslintFileResult {
    filePath?: unknown;
    messages?: unknown;
}

/** One ESLint finding, carrying the location and text a consumer can act on. */
interface Finding {
    file: string;
    line: number;
    column: number;
    rule: string;
    message: string;
}

function toFinding({
    file,
    message,
}: {
    file: string;
    message: EslintMessage;
}): Finding {
    return {
        file,
        line: typeof message.line === "number" ? message.line : 0,
        column: typeof message.column === "number" ? message.column : 0,
        rule:
            typeof message.ruleId === "string" ? message.ruleId : "parse error",
        message: typeof message.message === "string" ? message.message : "",
    };
}

/** Error-severity findings from one ESLint file report. */
function fileFindings({ raw }: { raw: EslintFileResult }): Finding[] {
    const file = raw?.filePath;
    const messages = raw?.messages;
    if (typeof file !== "string" || !Array.isArray(messages)) {
        return [];
    }
    return (messages as EslintMessage[])
        .filter((message) => message?.severity === 2)
        .map((message) => toFinding({ file, message }));
}

/** Error-severity messages from ESLint's JSON output; [] when unparseable. */
function parseFindings({ stdout }: { stdout: string }): Finding[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    return (parsed as EslintFileResult[]).flatMap((raw) =>
        fileFindings({ raw }),
    );
}

/** Every finding as a repo-relative diagnostic (complete, never truncated). */
function findingsToDiagnostics({
    findings,
    workingRoot,
}: {
    findings: Finding[];
    workingRoot: string;
}): StepDiagnostic[] {
    return findings.map((finding) => ({
        kind: "finding",
        file: relative(workingRoot, finding.file),
        line: finding.line,
        column: finding.column,
        rule: finding.rule,
        message: finding.message,
    }));
}

/** First non-empty line of a result's output, for a one-line notice. */
function firstLine({ result }: { result: CommandResult }): string {
    const text =
        [result.stderr, result.stdout]
            .map((stream) => stream.trim())
            .find((stream) => stream !== "") ?? "no output";
    return text.split("\n")[0] ?? "";
}

/**
 * Fix-mode-only sidecar management: with a repo config, write/refresh the
 * house example beside it; without one, remove a stale example. A read-only
 * verify never writes. The sidecar's lifecycle lives in lib/eslint-example.mts,
 * shared with bootstrap (a repair may have deleted the config since — #62).
 */
async function manageExample({
    mode,
    kind,
    workingRoot,
    notifyFn,
}: {
    mode: EslintRunContext["mode"];
    kind: ConfigKind;
    workingRoot: string;
    notifyFn: (line: string) => void;
}): Promise<void> {
    if (mode !== "fix") {
        return;
    }
    if (kind === "repo") {
        const desired = await readFile(
            gateConfigPath({ name: "eslint.config.mjs" }),
            "utf8",
        );
        await writeExample({ workingRoot, desired, notify: notifyFn });
        return;
    }
    await removeExample({ workingRoot });
}

/**
 * The house config's overrides as an env overlay: `.defined.json`
 * "eslint": { "complexityMax": N | false } forwarded as
 * DEFINED_ESLINT_COMPLEXITY_MAX and
 * "eslint": { "requireJsdoc": false } forwarded as
 * DEFINED_ESLINT_REQUIRE_JSDOC (a baked config cannot read the repo).
 * Undefined when neither is set — the baked config keeps its own defaults; a
 * repo-owned config governs itself and must not see either variable.
 */
function houseConfigEnv(config: DefinedConfig): NodeJS.ProcessEnv | undefined {
    const max = config.eslint?.complexityMax;
    const requireJsdoc = config.eslint?.requireJsdoc;
    if (max === undefined && requireJsdoc === undefined) {
        return undefined;
    }
    return {
        ...process.env,
        ...(max === undefined
            ? {}
            : {
                  DEFINED_ESLINT_COMPLEXITY_MAX:
                      max === false ? "off" : String(max),
              }),
        ...(requireJsdoc === undefined
            ? {}
            : { DEFINED_ESLINT_REQUIRE_JSDOC: requireJsdoc ? "on" : "off" }),
    };
}

/**
 * The repair pass: run `eslint --fix` and report only a real execution error.
 * Exit 1 means findings were left unfixed — verification reports them — so it
 * is not a failure here; any other non-zero is a config/parse crash and is.
 */
function repairEslint({
    kind,
    configPath,
    files,
    workingRoot,
    runner,
    env,
}: {
    kind: ConfigKind;
    configPath: string;
    files: string[];
    workingRoot: string;
    runner: Runner;
    env?: NodeJS.ProcessEnv;
}): StepResult {
    const fix = invokeEslint({
        kind,
        configPath,
        files,
        fix: true,
        workingRoot,
        runner,
        env,
    });
    if (fix.status !== 0 && fix.status !== 1) {
        return errored({
            message: `eslint: fix failed (${KIND_LABEL[kind]}): ${firstLine({ result: fix })}`,
        });
    }
    return passed({
        notice: `eslint: fixed ${files.length} file(s) (${KIND_LABEL[kind]})`,
    });
}

/**
 * Lint the repo's git-scoped JS/TS. Skips when the step is disabled or nothing
 * is lintable; otherwise runs the repo's config when present, else the baked
 * house config, and reports on a final no-fix pass.
 */
export async function runEslintStep({
    ctx,
    trackedFiles,
    runner = run,
    notifyFn = (line) => process.stderr.write(`${line}\n`),
}: {
    ctx: EslintRunContext;
    trackedFiles: string[];
    runner?: Runner;
    notifyFn?: (line: string) => void;
}): Promise<StepResult> {
    const config = await loadConfig({ repoRoot: ctx.repoRoot });
    if (config.eslint?.disable === true) {
        return skipped({ notice: "eslint: disabled by .defined.json" });
    }

    const files = filterEslintFiles({ files: trackedFiles });
    if (files.length === 0) {
        return skipped({ notice: "eslint: no tracked JS/TS files" });
    }

    const kind: ConfigKind = hasConsumerEslintConfig({ files: trackedFiles })
        ? "repo"
        : "house";
    const workingRoot = resolveWorkingRoot({
        mode: ctx.mode,
        repoRoot: ctx.repoRoot,
        scratch: ctx.scratch,
        files: trackedFiles,
    });

    await manageExample({ mode: ctx.mode, kind, workingRoot, notifyFn });

    const configPath = gateConfigPath({ name: "eslint.config.mjs" });
    const env = kind === "house" ? houseConfigEnv(config) : undefined;
    // Repair (#65): mutate only — eslint --fix. The lint check is the single
    // authoritative no-fix pass; a fix that leaves findings is caught there.
    if (ctx.mode === "fix") {
        return repairEslint({
            kind,
            configPath,
            files,
            workingRoot,
            runner,
            env,
        });
    }
    const check = invokeEslint({
        kind,
        configPath,
        files,
        fix: false,
        workingRoot,
        runner,
        env,
    });
    if (check.status === 0) {
        return passed({
            notice: `eslint: ${files.length} file(s) clean (${KIND_LABEL[kind]})`,
        });
    }
    return lintFailure({ check, kind, workingRoot });
}

/**
 * Turn a non-zero ESLint run into a result: a config/parse error (exit ≠ 1) is
 * an execution problem, a lint run with findings is a fail carrying one
 * diagnostic per finding, and anything else is a fail naming the output.
 */
function lintFailure({
    check,
    kind,
    workingRoot,
}: {
    check: CommandResult;
    kind: ConfigKind;
    workingRoot: string;
}): StepResult {
    const label = KIND_LABEL[kind];
    if (check.status !== 1) {
        return errored({
            message: `eslint: config/parse error (${label}): ${firstLine({ result: check })}`,
        });
    }
    const findings = parseFindings({ stdout: check.stdout });
    if (findings.length === 0) {
        return failed({
            notice: `eslint: lint failed (${label}): ${firstLine({ result: check })}`,
        });
    }
    return failed({
        notice: `eslint: ${findings.length} finding(s) (${label})`,
        errors: findingsToDiagnostics({ findings, workingRoot }),
    });
}
