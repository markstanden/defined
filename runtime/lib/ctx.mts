// lib/ctx.mts — command parsing and run-context assembly for the gate.
//
// The public contract is exactly two verbs (decision #23): `comply` (bootstrap
// + repair + verify) and `verify` (read-only check). Everything else — no
// verb, unknown verbs, the old public `setup`, and the retired `--fix` /
// `--no-fix` / `--silent` flags — is a concise usage error with a non-zero
// exit. Never imports steps.

import { deriveRepoRoot } from "../../lib/paths.mts";

export type Verb = "comply" | "verify";
export type StepMode = "fix" | "no-fix";

export interface ParsedCommand {
    verb: Verb;
    help: boolean;
}

export interface RunContext {
    verb: Verb;
    repoRoot: string;
}

/** Retired public surface: the one-line reason it went away. */
const RETIRED: Record<string, string> = {
    setup: "'setup' is no longer public — run 'comply' to bootstrap",
    "--fix": "'--fix' is gone — run 'comply' to repair",
    "--no-fix": "'--no-fix' is gone — run 'verify' to check",
    "--silent": "'--silent' is gone — run 'verify' to check",
};

function parseHelp({ argv }: { argv: string[] }): ParsedCommand {
    if (argv.length > 1) {
        throw new Error(`unexpected argument: ${argv[1]}`);
    }
    return { verb: "verify", help: true };
}

/**
 * Parse the positional verb. Returns help for `-h`/`--help`; throws a concise
 * usage error for anything else so typos never silently change behaviour.
 */
export function parseCommand({ argv }: { argv: string[] }): ParsedCommand {
    if (argv.length === 0) {
        throw new Error("missing command — expected 'comply' or 'verify'");
    }
    if (argv[0] === "-h" || argv[0] === "--help") {
        return parseHelp({ argv });
    }
    if (argv.length > 1) {
        throw new Error(`unexpected argument: ${argv[1]}`);
    }
    const verb = argv[0] as string;
    if (verb === "comply" || verb === "verify") {
        return { verb, help: false };
    }
    if (RETIRED[verb] !== undefined) {
        throw new Error(RETIRED[verb]!);
    }
    throw new Error(
        `unknown command '${verb}' — expected 'comply' or 'verify'`,
    );
}

/** Assemble a full run context, deriving the repo root from startDir. */
export async function createRunContext({
    verb,
    startDir,
}: {
    verb: Verb;
    startDir: string;
}): Promise<RunContext> {
    const repoRoot = await deriveRepoRoot({ startDir });
    return { verb, repoRoot };
}
