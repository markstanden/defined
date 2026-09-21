// lib/prettier-config.mts — consumer Prettier config discovery.
//
// The `node` formatting step prefers a consumer-owned Prettier config at the
// repo root over the gate's travelling defaults. When that config declares
// plugins, the gate must restore the root package's dependencies before
// prettier loads it (issue #40) — otherwise a fresh checkout fails to resolve
// the plugins. This module owns the canonical file-name list so config
// discovery and the node-deps restore agree on what counts as a consumer
// config; the list follows prettier's own resolution order.
//
// The gate only ever looks at the repo root (a nested config is not the gate's
// business), so matching is by basename at depth 0.

export const CONSUMER_PRETTIER_CONFIGS = [
    "prettier.config.mjs",
    "prettier.config.js",
    "prettier.config.cjs",
    "prettier.config.mts",
    "prettier.config.cts",
    "prettier.config.ts",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.json5",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    ".prettierrc.js",
    ".prettierrc.mjs",
    ".prettierrc.cjs",
    ".prettierrc.ts",
] as const;

/**
 * True when the git-scoped file list contains a consumer-owned Prettier config
 * at the repo root. Data-driven (no filesystem reads) so callers can decide
 * whether prettier will load a consumer config before touching a scratch copy.
 */
export function hasConsumerPrettierConfig({
    files,
}: {
    files: string[];
}): boolean {
    return files.some(
        (file) =>
            !file.includes("/") &&
            (CONSUMER_PRETTIER_CONFIGS as readonly string[]).includes(file),
    );
}
