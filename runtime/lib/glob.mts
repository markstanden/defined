// lib/glob.mts — the one documented glob dialect for consumer selectors.
//
// Selectors are repo-relative and anchored: `*` matches one path segment, `**`
// matches zero or more whole segments, and `?` matches one non-separator
// character. A selector can never match outside the git inventory it is applied
// to, so selection never widens the gate's scope.
//
// The dialect is shared by every consumer-declared selector (`scope.include`,
// `purity.pureModules`) so one documented grammar governs the whole config.

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

/** True when a selector carries glob syntax rather than naming one exact path. */
export function isGlob(selector: string): boolean {
    return selector.includes("*") || selector.includes("?");
}

/** Compile a documented glob into an anchored regular expression. */
export function globToRegExp(selector: string): RegExp {
    let source = "";
    for (let index = 0; index < selector.length; index += 1) {
        const char = selector[index]!;
        if (char === "*") {
            if (selector[index + 1] === "*") {
                if (selector[index + 2] === "/") {
                    source += "(?:[^/]+/)*";
                    index += 2;
                } else {
                    source += ".*";
                    index += 1;
                }
            } else {
                source += "[^/]*";
            }
        } else if (char === "?") {
            source += "[^/]";
        } else {
            source += char.replace(REGEX_SPECIAL, String.raw`\$&`);
        }
    }
    return new RegExp(`^${source}$`, "u");
}

/**
 * True when the repo-relative `file` matches `selector`. An exact selector
 * compares literally; anything carrying glob syntax is compiled and anchored.
 */
export function matchesGlob({
    selector,
    file,
}: {
    selector: string;
    file: string;
}): boolean {
    return globMatcher(selector)(file);
}

/**
 * Compile one selector once for many files: the reusable form of
 * `matchesGlob`, for callers that match a selector against a whole inventory.
 */
export function globMatcher(selector: string): (file: string) => boolean {
    if (!isGlob(selector)) {
        return (file) => selector === file;
    }
    const regex = globToRegExp(selector);
    return (file) => regex.test(file);
}
