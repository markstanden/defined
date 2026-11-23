// lib/purity.mts — purity/CQS policy selection over the gate's git scope.
//
// The step receives the git inventory (tracked plus untracked, non-ignored) and
// the validated `.defined.json` policy; this module turns the two into the
// shape the baked rule consumes. No filesystem reads: selection is a pure
// function of the file list, so there is no second walk and no scratch copy.
//
// Selectors are positive: an exact repo-relative path or a documented glob
// (`*` one segment, `**` zero or more segments, `?` one character). Every
// selector must match at least one supported in-scope file; a stale selector is
// a configuration error, never a silent pass. CQS targets are exact files and
// local top-level binding names — the rule reports a stale or unsupported
// symbol against the source.

import type { PurityConfig, PurityTarget } from "./config.mts";
import { matchesGlob } from "./glob.mts";
import { hasJsTsExtension } from "./js-files.mts";

/** One file's command/query declarations, as the baked rule sees them. */
export interface PurityFilePolicy {
    /** Names that must not return a value. */
    commands: string[];
    /** Names that must not write observable state. */
    queries: string[];
}

/** The resolved policy handed to the baked rule through the environment. */
export interface PurityPolicy {
    /** Repo-relative pure modules, deduped, in git order. */
    pure: string[];
    /** Per-file CQS declarations; files with no declaration are absent. */
    cqs: Record<string, PurityFilePolicy>;
}

/**
 * True when the repo-relative `file` matches the positive `selector`.
 * Exact selectors compare literally; `*` never crosses `/`, `**` spans zero or
 * more whole segments, and `?` matches one non-separator character. The dialect
 * itself lives in lib/glob.mts, shared with `scope.include`.
 */
export function selectorMatches({
    selector,
    file,
}: {
    selector: string;
    file: string;
}): boolean {
    return matchesGlob({ selector, file });
}

function groupTargets(
    cqs: Record<string, PurityFilePolicy>,
    targets: PurityTarget[],
    role: "commands" | "queries",
): void {
    for (const target of targets) {
        cqs[target.file] ??= { commands: [], queries: [] };
        cqs[target.file]![role].push(target.name);
    }
}

/**
 * Resolve the declared policy against the git-scoped file list.
 *
 * Throws when a selector matches no supported file, or a CQS target names a
 * file outside the scope — both are stale-policy errors the operator must fix,
 * not findings about the code. The resulting file order follows the inventory,
 * so repeated runs are deterministic.
 */
export function selectPurityPolicy({
    config,
    files,
}: {
    config: PurityConfig;
    files: string[];
}): PurityPolicy {
    const supported = files.filter((file) => hasJsTsExtension({ file }));
    const selectors = config.pureModules ?? [];
    for (const selector of selectors) {
        const matched = supported.some((file) =>
            selectorMatches({ selector, file }),
        );
        if (!matched) {
            throw new Error(
                `purity: pureModules selector "${selector}" matches no supported file among the gated files`,
            );
        }
    }
    const pure = supported.filter((file) =>
        selectors.some((selector) => selectorMatches({ selector, file })),
    );
    for (const target of config.commands ?? []) {
        requireInScope({ target, files, role: "command" });
    }
    for (const target of config.queries ?? []) {
        requireInScope({ target, files, role: "query" });
    }
    const cqs: Record<string, PurityFilePolicy> = {};
    groupTargets(cqs, config.commands ?? [], "commands");
    groupTargets(cqs, config.queries ?? [], "queries");
    return { pure, cqs };
}

/** Throw when a declared CQS target file is not a parseable file in scope. */
function requireInScope({
    target,
    files,
    role,
}: {
    target: PurityTarget;
    files: string[];
    role: "command" | "query";
}): void {
    if (
        !files.includes(target.file) ||
        !hasJsTsExtension({ file: target.file })
    ) {
        throw new Error(
            `purity: ${role} "${target.name}" is declared in "${target.file}", which is not among the gated files`,
        );
    }
}

/** Serialise the policy for the baked ESLint config's env channel. */
export function purityPolicyEnv({ policy }: { policy: PurityPolicy }): string {
    return JSON.stringify(policy);
}
