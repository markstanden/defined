// House ESLint config — baked in runtime/config/ and selected with --config, so
// it resolves its plugins from the image. Node ESM resolves these bare imports
// relative to THIS file's location, so the plugins must sit in the resolution
// chain above it (/opt/defined/node_modules — see the Containerfile), never in
// the global npm prefix alone. Keep the imports in step with
// runtime/tool-versions.env.
//
// A repo that supplies its own eslint.config.* runs that instead, and is offered
// eslint.config.defined.mjs beside it as an example of this file. Nothing is
// installed into, or written to, a repo that has no config.
//
// v1 is deliberately narrow: the super-linear-regex floor that motivated the
// step (the local reproduction of Sonar typescript:S8786). The full @eslint/js
// and typescript-eslint *recommended* rule sets are deferred to v2 so a pin
// bump cannot turn every consumer red at once. Add rules as they earn their
// place, and date each addition.
//
// Canonical copy:
// https://github.com/markstanden/defined/blob/main/runtime/config/eslint.config.mjs
import tseslint from "typescript-eslint";
import regexp from "eslint-plugin-regexp";
import prettierConfig from "eslint-config-prettier";

// The extensions the gate lints. An ESLint config object needs a `files` match
// before ESLint will consider a non-JS file such as .mts at all; the step
// passes the git-scoped files as explicit paths filtered to this same set.
const LINT_FILES = [
    "**/*.js",
    "**/*.mjs",
    "**/*.cjs",
    "**/*.jsx",
    "**/*.ts",
    "**/*.mts",
    "**/*.cts",
    "**/*.tsx",
];

export default [
    {
        files: LINT_FILES,
        // Only typescript-eslint's parser is used in v1: it is needed to see the
        // AST of a .ts/.mts file at all. Its rules are deferred to v2.
        languageOptions: { parser: tseslint.parser },
        plugins: { regexp },
        rules: {
            // 2026-09-26: v1 floor. no-super-linear-move is the rule that
            // catches the motivating system-config spelling
            // /\[[^\]]*\]\(([^)]*)\)/g (fixed in its PR #62); the sibling
            // no-super-linear-backtracking covers the classic exponential cases.
            "regexp/no-super-linear-backtracking": "error",
            "regexp/no-super-linear-move": "error",
        },
    },
    // eslint-config-prettier must be last: formatting is prettier's job, so
    // switch off every ESLint rule that would fight it.
    { ...prettierConfig, files: LINT_FILES },
];
