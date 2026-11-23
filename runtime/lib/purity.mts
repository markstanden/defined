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
 * Resolve the declared policy against the gated file list.
 *
 * `files` is the content scope (`.defined.json` `scope.include` narrowed, or
 * the whole git inventory when it is absent) and decides what purity judges.
 * `allFiles` is the whole git inventory and exists only to diagnose a throw:
 * it separates a stale selector or target (nothing in the repository matches)
 * from one pointing outside the declared content scope.
 *
 * Throws when a selector matches no supported file, or a CQS target names a
 * file purity cannot judge — both are policy errors the operator must fix, not
 * findings about the code. The resulting file order follows the inventory,
 * so repeated runs are deterministic.
 */
export function selectPurityPolicy({
    config,
    files,
    allFiles = files,
}: {
    config: PurityConfig;
    files: string[];
    /** The whole git inventory, for the diagnostic only. Defaults to `files`. */
    allFiles?: string[];
}): PurityPolicy {
    const supported = files.filter((file) => hasJsTsExtension({ file }));
    const supportedAll = allFiles.filter((file) => hasJsTsExtension({ file }));
    const selectors = config.pureModules ?? [];
    for (const selector of selectors) {
        requireSelectorInScope({ selector, supported, supportedAll });
    }
    const pure = supported.filter((file) =>
        selectors.some((selector) => selectorMatches({ selector, file })),
    );
    for (const target of config.commands ?? []) {
        requireInScope({ target, files, allFiles, role: "command" });
    }
    for (const target of config.queries ?? []) {
        requireInScope({ target, files, allFiles, role: "query" });
    }
    const cqs: Record<string, PurityFilePolicy> = {};
    groupTargets(cqs, config.commands ?? [], "commands");
    groupTargets(cqs, config.queries ?? [], "queries");
    return { pure, cqs };
}

/**
 * Throw unless `selector` matches at least one supported file purity judges.
 * A selector matching only outside the gated files names an example and the
 * two fixes; one matching nothing anywhere is stale.
 */
function requireSelectorInScope({
    selector,
    supported,
    supportedAll,
}: {
    selector: string;
    supported: string[];
    supportedAll: string[];
}): void {
    if (supported.some((file) => selectorMatches({ selector, file }))) {
        return;
    }
    const outside = supportedAll.find((file) =>
        selectorMatches({ selector, file }),
    );
    if (outside !== undefined) {
        throw new Error(
            `purity: pureModules selector "${selector}" matches only files outside the content scope declared by scope.include (e.g. "${outside}") — widen the scope or remove the selector`,
        );
    }
    throw new Error(
        `purity: pureModules selector "${selector}" matches no supported file in the git scope`,
    );
}

/** Throw when a declared CQS target file is not a parseable file purity judges. */
function requireInScope({
    target,
    files,
    allFiles,
    role,
}: {
    target: PurityTarget;
    files: string[];
    allFiles: string[];
    role: "command" | "query";
}): void {
    if (
        files.includes(target.file) &&
        hasJsTsExtension({ file: target.file })
    ) {
        return;
    }
    if (!allFiles.includes(target.file)) {
        throw new Error(
            `purity: ${role} "${target.name}" is declared in "${target.file}", which is not in the git scope`,
        );
    }
    if (!hasJsTsExtension({ file: target.file })) {
        throw new Error(
            `purity: ${role} "${target.name}" is declared in "${target.file}", which is not a parseable JS/TS file`,
        );
    }
    throw new Error(
        `purity: ${role} "${target.name}" is declared in "${target.file}", which is outside the content scope declared by scope.include — widen the scope or move the declaration`,
    );
}

/** Serialise the policy for the baked ESLint config's env channel. */
export function purityPolicyEnv({ policy }: { policy: PurityPolicy }): string {
    return JSON.stringify(policy);
}
