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
// Fix:      --fix first, then always re-run without --fix and report on the
//           re-run — a fix that leaves findings can never read as success.
//           --fix rewrites repo code (that is what `comply` is for); the
//           read-only `verify` pass never writes.
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

import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
    failed,
    passed,
    skipped,
    type StepResult,
} from "../lib/step-result.mts";
import { resolveWorkingRoot, type Scratch } from "../lib/scratch.mts";
import { run, type CommandResult } from "../../lib/proc.mts";
import { gateConfigPath } from "../lib/config-path.mts";
import { loadConfig, type DefinedConfig } from "../lib/config.mts";
import {
    ESLINT_EXAMPLE_NAME,
    hasConsumerEslintConfig,
} from "../lib/eslint-config.mts";
import { runWithLocalBin } from "../lib/node-packages.mts";

export interface EslintRunContext {
    mode: "fix" | "no-fix";
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

/** How many findings the notice names before it stops listing. */
const MAX_SHOWN = 5;

/** Keep only the tracked files ESLint can parse (the house config's set). */
export function filterEslintFiles({ files }: { files: string[] }): string[] {
    return files.filter((file) => {
        const dot = file.lastIndexOf(".");
        if (dot === -1) {
            return false;
        }
        const ext = file.slice(dot + 1);
        return (ESLINT_EXTENSIONS as readonly string[]).includes(ext);
    });
}

/** Single-quote an argument for `sh -c` (the repo-config branch only). */
function shellQuote(arg: string): string {
    return `'${arg.replaceAll("'", "'\\''")}'`;
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
        .map(shellQuote)
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
}

interface EslintFileResult {
    filePath?: unknown;
    messages?: unknown;
}

interface Finding {
    file: string;
    line: number;
    rule: string;
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
        rule:
            typeof message.ruleId === "string" ? message.ruleId : "parse error",
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

/** First non-empty line of a result's output, for a one-line notice. */
function firstLine({ result }: { result: CommandResult }): string {
    const text =
        [result.stderr, result.stdout]
            .map((stream) => stream.trim())
            .find((stream) => stream !== "") ?? "no output";
    return text.split("\n")[0] ?? "";
}

function failureNotice({
    kind,
    result,
    workingRoot,
}: {
    kind: ConfigKind;
    result: CommandResult;
    workingRoot: string;
}): string {
    const label = KIND_LABEL[kind];
    // Exit 2 is ESLint's fatal/config error; 1 is a lint finding. Both fail,
    // but the agent needs to know which.
    if (result.status !== 1) {
        return `eslint: config/parse error (${label}): ${firstLine({ result })}`;
    }
    const findings = parseFindings({ stdout: result.stdout });
    if (findings.length === 0) {
        return `eslint: lint failed (${label}): ${firstLine({ result })}`;
    }
    const shown = findings
        .slice(0, MAX_SHOWN)
        .map((f) => `${relative(workingRoot, f.file)}:${f.line} ${f.rule}`)
        .join("; ");
    const extra =
        findings.length > MAX_SHOWN
            ? ` (+${findings.length - MAX_SHOWN} more)`
            : "";
    return `eslint: ${findings.length} finding(s) (${label}): ${shown}${extra}`;
}

function excludeFilePath({ repoRoot }: { repoRoot: string }): string {
    return join(repoRoot, ".git", "info", "exclude");
}

/** Add the sidecar to .git/info/exclude; false when git or the entry is absent. */
async function excludeExample({
    repoRoot,
}: {
    repoRoot: string;
}): Promise<boolean> {
    const excludePath = excludeFilePath({ repoRoot });
    if (!existsSync(dirname(excludePath))) {
        return false;
    }
    const current = existsSync(excludePath)
        ? await readFile(excludePath, "utf8")
        : "";
    if (current.split("\n").includes(ESLINT_EXAMPLE_NAME)) {
        return false;
    }
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await writeFile(
        excludePath,
        `${current}${separator}${ESLINT_EXAMPLE_NAME}\n`,
    );
    return true;
}

async function pruneExampleExclusion({
    repoRoot,
}: {
    repoRoot: string;
}): Promise<void> {
    const excludePath = excludeFilePath({ repoRoot });
    if (!existsSync(excludePath)) {
        return;
    }
    const current = await readFile(excludePath, "utf8");
    const next = current
        .split("\n")
        .filter((line) => line !== ESLINT_EXAMPLE_NAME)
        .join("\n");
    if (next !== current) {
        await writeFile(excludePath, next);
    }
}

/** Write/refresh the house-example sidecar and notice the consumer. */
async function writeExample({
    workingRoot,
    notify,
}: {
    workingRoot: string;
    notify: (line: string) => void;
}): Promise<void> {
    const examplePath = join(workingRoot, ESLINT_EXAMPLE_NAME);
    const desired = await readFile(
        await gateConfigPath({ name: "eslint.config.mjs" }),
        "utf8",
    );
    const current = existsSync(examplePath)
        ? await readFile(examplePath, "utf8")
        : "";
    if (current !== desired) {
        await writeFile(examplePath, desired);
    }
    const excluded = await excludeExample({ repoRoot: workingRoot });
    notify(
        `defined: repo eslint config kept; wrote ${ESLINT_EXAMPLE_NAME} (house example)` +
            (excluded ? " and added it to .git/info/exclude" : ""),
    );
}

/** Remove a now-redundant sidecar when the repo has no config of its own. */
async function removeExample({
    workingRoot,
}: {
    workingRoot: string;
}): Promise<void> {
    const examplePath = join(workingRoot, ESLINT_EXAMPLE_NAME);
    if (existsSync(examplePath)) {
        await rm(examplePath, { force: true });
    }
    await pruneExampleExclusion({ repoRoot: workingRoot });
}

/**
 * Fix-mode-only sidecar management: with a repo config, write/refresh the
 * house example beside it; without one, remove a stale example. A read-only
 * verify never writes.
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
        await writeExample({ workingRoot, notify: notifyFn });
        return;
    }
    await removeExample({ workingRoot });
}

/**
 * The house config's complexity ceiling as an env overlay: `.defined.json`
 * "eslint": { "complexityMax": N | false } forwarded as
 * DEFINED_ESLINT_COMPLEXITY_MAX (a baked config cannot read the repo).
 * Undefined when unset — the baked config keeps its own default; a repo-owned
 * config governs itself and must not see the variable.
 */
function complexityEnv(config: DefinedConfig): NodeJS.ProcessEnv | undefined {
    const max = config.eslint?.complexityMax;
    if (max === undefined) {
        return undefined;
    }
    return {
        ...process.env,
        DEFINED_ESLINT_COMPLEXITY_MAX: max === false ? "off" : String(max),
    };
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

    const configPath = await gateConfigPath({ name: "eslint.config.mjs" });
    const env = kind === "house" ? complexityEnv(config) : undefined;
    if (ctx.mode === "fix") {
        invokeEslint({
            kind,
            configPath,
            files,
            fix: true,
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
    return failed({
        notice: failureNotice({ kind, result: check, workingRoot }),
    });
}
