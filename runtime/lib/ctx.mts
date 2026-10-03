// lib/ctx.mts — command parsing and run-context assembly for the gate.
//
// The public contract is two result verbs (decision #23) plus a read-only
// guidance verb: `comply` (bootstrap + repair + verify), `verify` (read-only
// check) and `explain <step-or-rule>` (offline house guidance, #74). Each result
// verb accepts an optional presentation flag: `--min` (default) keeps `status`
// and every diagnostic; `--full` adds the per-check results map, worth one
// contextual run and noise thereafter. `--timings` is an independent opt-in
// (issue #71): it adds monotonic phase/step durations on stderr and never
// changes the stdout contract. `explain` takes exactly one topic and no
// flags. Everything else — no verb,
// unknown verbs, the old public `setup`, and the retired `--fix` / `--no-fix` /
// `--silent` flags — is a concise usage error with a non-zero exit. Never
// imports steps.

import { deriveRepoRoot } from "../../lib/paths.mts";
import type { Presentation } from "./report.mts";

export type Verb = "comply" | "verify" | "explain";
export type StepMode = "fix" | "no-fix";

/** Concise output is the default; `--full` opts into the results map. */
const DEFAULT_PRESENTATION: Presentation = "min";

export interface ParsedCommand {
    /** The parsed verb: comply, verify or explain. */
    verb: Verb;
    /** True when `--help` was requested (usage text, exit 2). */
    help: boolean;
    /** Presentation mode honoured by the report phase. */
    presentation: Presentation;
    /** True when `--timings` was requested (stderr phase/step durations). */
    timings: boolean;
    /** `explain` only: the step id or rule id to look up. */
    topic?: string;
}

export interface RunContext {
    /** The parsed verb — comply, verify or explain. */
    verb: Verb;
    /** The repo this invocation operates on (never the gate's own code). */
    repoRoot: string;
    /** Presentation mode honoured by the report phase. */
    presentation: Presentation;
    /** True when `--timings` was requested (stderr phase/step durations). */
    timings: boolean;
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
 * Parse the positional verb and its presentation flag. Returns help for
 * `-h`/`--help`; throws a concise usage error for anything else so typos never
 * silently change behaviour.
 */
export function parseCommand({ argv }: { argv: string[] }): ParsedCommand {
    if (argv.length === 0) {
        throw new Error("missing command — expected 'comply' or 'verify'");
    }
    if (argv[0] === "-h" || argv[0] === "--help") {
        return parseHelp({ argv });
    }
    const verb = argv[0] as string;
    if (verb === "explain") {
        return parseExplain({ argv });
    }
    if (verb !== "comply" && verb !== "verify") {
        if (RETIRED[verb] !== undefined) {
            throw new Error(RETIRED[verb]!);
        }
        throw new Error(
            `unknown command '${verb}' — expected 'comply', 'verify' or 'explain'`,
        );
    }
    const { presentation, timings } = parseOutputFlags({ argv: argv.slice(1) });
    return { verb, help: false, presentation, timings };
}

/** Assemble a full run context, deriving the repo root from startDir. */
export async function createRunContext({
    verb,
    startDir,
    presentation,
    timings,
}: {
    verb: Verb;
    startDir: string;
    presentation: Presentation;
    timings: boolean;
}): Promise<RunContext> {
    const repoRoot = await deriveRepoRoot({ startDir });
    return { verb, repoRoot, presentation, timings };
}
