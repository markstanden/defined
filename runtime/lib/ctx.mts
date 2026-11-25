// lib/ctx.mts — command parsing and run-context assembly for the gate.
//
// The public contract is three result verbs (decision #23) plus a read-only
// guidance verb: `comply` (bootstrap + repair + verify), `verify` (read-only
// check), `scan` (read-only check without the bootstrap check: never adopts)
// and `explain <step-or-rule>` (offline house guidance, #74). Each result
// verb accepts an optional presentation flag: `--min` (default) keeps `status`
// and every diagnostic; `--full` adds the per-check results map, worth one
// contextual run and noise thereafter. `--timings` is an independent opt-in
// (issue #71): it adds monotonic phase/step durations on stderr and never
// changes the stdout contract. `scan` also accepts `--files <paths…>`: exactly
// the named files replace `scope.include` for every content check, and a path
// that does not exist on disk or is outside the git inventory is a usage error.
// `explain` takes exactly one topic and no flags. Everything else — no verb,
// unknown verbs, the old public `setup`, and the retired `--fix` / `--no-fix` /
// `--silent` flags — is a concise usage error with a non-zero exit. Never
// imports steps.

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { deriveRepoRoot } from "../../lib/paths.mts";
import type { Presentation } from "./report.mts";

export type Verb = "comply" | "verify" | "scan" | "explain";
export type StepMode = "fix" | "no-fix";

/** Concise output is the default; `--full` opts into the results map. */
const DEFAULT_PRESENTATION: Presentation = "min";

export interface ParsedCommand {
    /** The parsed verb: comply, verify, scan or explain. */
    verb: Verb;
    /** True when `--help` was requested (usage text, exit 2). */
    help: boolean;
    /** Presentation mode honoured by the report phase. */
    presentation: Presentation;
    /** True when `--timings` was requested (stderr phase/step durations). */
    timings: boolean;
    /** `explain` only: the step id or rule id to look up. */
    topic?: string;
    /** `scan` only: exactly the files the pass is narrowed to. */
    files?: readonly string[];
}

export interface RunContext {
    /** The parsed verb — comply, verify, scan or explain. */
    verb: Verb;
    /** The repo this invocation operates on (never the gate's own code). */
    repoRoot: string;
    /** Presentation mode honoured by the report phase. */
    presentation: Presentation;
    /** True when `--timings` was requested (stderr phase/step durations). */
    timings: boolean;
    /** `scan --files` only: repo-relative paths the pass is narrowed to. */
    files?: readonly string[];
}

/** Retired public surface: the one-line reason it went away. */
const RETIRED: Record<string, string> = {
    setup: "'setup' is no longer public — run 'comply' to bootstrap",
    "--fix": "'--fix' is gone — run 'comply' to repair",
    "--no-fix": "'--no-fix' is gone — run 'verify' to check",
    "--silent": "'--silent' is gone — run 'verify' to check",
};

/** Parse `explain <topic>`: exactly one non-flag topic, no presentation flags. */
function parseExplain({ argv }: { argv: string[] }): ParsedCommand {
    const topic = argv[1];
    if (topic === undefined || topic.startsWith("-")) {
        throw new Error("explain needs a topic — e.g. 'defined explain shell'");
    }
    if (argv.length > 2) {
        throw new Error(`unexpected argument: ${argv[2]}`);
    }
    return {
        verb: "explain",
        help: false,
        presentation: DEFAULT_PRESENTATION,
        timings: false,
        topic,
    };
}

function parseHelp({ argv }: { argv: string[] }): ParsedCommand {
    if (argv.length > 1) {
        throw new Error(`unexpected argument: ${argv[1]}`);
    }
    return {
        verb: "verify",
        help: true,
        presentation: DEFAULT_PRESENTATION,
        timings: false,
    };
}

/**
 * Parse the output flags: `--min` or `--full` (at most one, absent means
 * `--min`), plus the independent `--timings` opt-in for stderr durations.
 */
function parseOutputFlags({ argv }: { argv: string[] }): {
    presentation: Presentation;
    timings: boolean;
} {
    let presentation: Presentation = DEFAULT_PRESENTATION;
    let chosen: "--min" | "--full" | undefined;
    let timings = false;
    for (const arg of argv) {
        if (arg === "--min" || arg === "--full") {
            if (chosen !== undefined && chosen !== arg) {
                throw new Error(
                    `conflicting presentation flags: ${chosen} and ${arg}`,
                );
            }
            chosen = arg;
            presentation = arg === "--min" ? "min" : "full";
        } else if (arg === "--timings") {
            timings = true;
        } else {
            throw new Error(`unexpected argument: ${arg}`);
        }
    }
    return { presentation, timings };
}

/**
 * Split the scan-only `--files <paths…>` values from the remaining flags. The
 * values run until the next flag, so `--files a.test.ts b.cs --full` is one
 * list plus a presentation flag.
 */
function parseFileFlags({ argv }: { argv: string[] }): {
    files?: string[];
    flags: string[];
} {
    const files: string[] = [];
    const flags: string[] = [];
    let sawFiles = false;
    let collecting = false;
    for (const arg of argv) {
        if (arg === "--files") {
            sawFiles = true;
            collecting = true;
            continue;
        }
        if (collecting && !arg.startsWith("-")) {
            files.push(arg);
            continue;
        }
        collecting = false;
        flags.push(arg);
    }
    if (files.length > 0) {
        return { files, flags };
    }
    if (sawFiles) {
        throw new Error("--files needs at least one path");
    }
    return { flags };
}

/** A result verb: everything except `explain` and the help pseudo-verb. */
type ResultVerb = Exclude<Verb, "explain">;

/** Parse a result verb's files and output flags. */
function parseResultVerb({
    verb,
    argv,
}: {
    verb: ResultVerb;
    argv: string[];
}): ParsedCommand {
    const { files, flags } = parseFileFlags({ argv });
    if (files !== undefined && verb !== "scan") {
        throw new Error("--files is a scan flag — verify has no file list");
    }
    const { presentation, timings } = parseOutputFlags({ argv: flags });
    return {
        verb,
        help: false,
        presentation,
        timings,
        ...(files === undefined ? {} : { files }),
    };
}

/**
 * Parse the positional verb and its flags. Returns help for `-h`/`--help`;
 * throws a concise usage error for anything else so typos never silently
 * change behaviour.
 */
export function parseCommand({ argv }: { argv: string[] }): ParsedCommand {
    if (argv.length === 0) {
        throw new Error(
            "missing command — expected 'comply', 'verify' or 'scan'",
        );
    }
    if (argv[0] === "-h" || argv[0] === "--help") {
        return parseHelp({ argv });
    }
    const verb = argv[0] as string;
    if (verb === "explain") {
        return parseExplain({ argv });
    }
    if (verb !== "comply" && verb !== "verify" && verb !== "scan") {
        if (RETIRED[verb] !== undefined) {
            throw new Error(RETIRED[verb]!);
        }
        throw new Error(
            `unknown command '${verb}' — expected 'comply', 'verify', 'scan' or 'explain'`,
        );
    }
    return parseResultVerb({ verb, argv: argv.slice(1) });
}

/**
 * Resolve one `--files` path to a repo-relative path. A path that does not
 * exist on disk, or resolves outside the repository, is a typo guard, not a
 * scan.
 */
function repoFile({
    repoRoot,
    startDir,
    file,
}: {
    repoRoot: string;
    startDir: string;
    file: string;
}): string {
    const absolute = resolve(startDir, file);
    if (!existsSync(absolute)) {
        throw new Error(`--files: no such file: ${file}`);
    }
    const relativePath = relative(repoRoot, absolute).split(sep).join("/");
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error(`--files: no such file in the repository: ${file}`);
    }
    return relativePath;
}

/**
 * Assemble a full run context, deriving the repo root from startDir and
 * resolving any `--files` paths against it.
 */
export async function createRunContext({
    verb,
    startDir,
    presentation,
    timings,
    files,
}: {
    verb: Verb;
    startDir: string;
    presentation: Presentation;
    timings: boolean;
    files?: readonly string[];
}): Promise<RunContext> {
    const repoRoot = await deriveRepoRoot({ startDir });
    return {
        verb,
        repoRoot,
        presentation,
        timings,
        ...(files === undefined
            ? {}
            : {
                  files: files.map((file) =>
                      repoFile({ repoRoot, startDir, file }),
                  ),
              }),
    };
}
