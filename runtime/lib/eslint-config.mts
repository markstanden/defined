// lib/eslint-config.mts — consumer ESLint config discovery.
//
// Mirrors lib/prettier-config.mts: the `eslint` step prefers a repo-owned flat
// config at the repo root over the gate's baked house config. When a consumer
// config is present the gate runs *theirs* (from the repo, so their plugins and
// ESLint version resolve) and writes the house default alongside as
// `eslint.config.defined.mjs` — the example sidecar. ESLint 10 supports flat
// config only, so the list is the flat-config name set; a repo still on
// `.eslintrc.*` is out of scope (its own declared `eslint .` check, if any, is
// unaffected).
//
// The gate only ever looks at the repo root (a nested config is not the gate's
// business), so matching is by basename at depth 0.

export const CONSUMER_ESLINT_CONFIGS = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    "eslint.config.mts",
    "eslint.config.cts",
] as const;

/**
 * Sidecar written beside a consumer config as the "current house default"
 * example. The name is deliberately not one ESLint discovers (it loads only the
 * exact ESLINT_CONFIGS names), so the sidecar is inert; it is also added to
 * `.git/info/exclude` so the gate's own git scope never sees it again.
 */
export const ESLINT_EXAMPLE_NAME = "eslint.config.defined.mjs";

/**
 * True when the git-scoped file list contains a consumer-owned ESLint config at
 * the repo root. Data-driven (no filesystem reads) so callers can decide before
 * touching a scratch copy.
 */
export function hasConsumerEslintConfig({
    files,
}: {
    files: string[];
}): boolean {
    return files.some(
        (file) =>
            !file.includes("/") &&
            (CONSUMER_ESLINT_CONFIGS as readonly string[]).includes(file),
    );
}
