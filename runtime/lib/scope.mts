// lib/scope.mts — the content-check scope: a positive allowlist over the git
// inventory.
//
// The repository is the gate's scope by default (decision #10), so an absent
// `scope.include` returns the inventory untouched. A present list narrows what
// the content checks *report on*: it never narrows the working copy, which is
// why callers keep passing the full inventory to the scratch materialiser and
// only the selection uses this result. A scope that selects nothing is an
// operator error, never a clean run — the caller turns it into a failure.

import { globMatcher } from "./glob.mts";

/**
 * Narrow the git inventory to the declared content scope. `include` absent or
 * empty means the whole inventory, in its original order.
 */
export function resolveScope({
    files,
    include,
}: {
    files: string[];
    include?: string[];
}): string[] {
    if (include === undefined || include.length === 0) {
        return files;
    }
    // Compile each selector once, not once per file: a scope is matched against
    // the whole inventory on every pass.
    const matchers = include.map(globMatcher);
    return files.filter((file) => matchers.some((matches) => matches(file)));
}
