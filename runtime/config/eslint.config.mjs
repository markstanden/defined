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
// step (the local reproduction of Sonar typescript:S8786), the cyclomatic-
// complexity floor, and the public-API documentation floor. The full @eslint/js
// and typescript-eslint *recommended* rule sets are deferred to v2 so a pin bump
// cannot turn every consumer red at once. Add rules as they earn their place,
// and date each addition.
//
// Canonical copy:
// https://github.com/markstanden/defined/blob/main/runtime/config/eslint.config.mjs
import tseslint from "typescript-eslint";
import regexp from "eslint-plugin-regexp";
import jsdoc from "eslint-plugin-jsdoc";
import prettierConfig from "eslint-config-prettier";

// The cyclomatic-complexity ceiling (2026-10-01): every function max 10 by
// default — deliberately tighter than Sonar's cognitive-complexity 15, so a
// branchy function surfaces at review time with its name and score, not at the
// next Sonar scan. A baked config cannot read the consumer's .defined.json, so
// the eslint step forwards an override as DEFINED_ESLINT_COMPLEXITY_MAX:
// "off" drops the rule, a positive integer is the max, anything else (or an
// unset variable) is the house default. A repo-owned config never sees this —
// it governs itself.
const DEFAULT_COMPLEXITY_MAX = 10;

function complexityMaxFromEnv() {
    const raw = process.env.DEFINED_ESLINT_COMPLEXITY_MAX;
    if (raw === undefined || raw === "") {
        return DEFAULT_COMPLEXITY_MAX;
    }
    if (raw === "off") {
        return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0
        ? parsed
        : DEFAULT_COMPLEXITY_MAX;
}

const complexityMax = complexityMaxFromEnv();

// The public-API documentation floor (2026-10-03): exported functions and
// arrow functions, public class properties and interface members need a JSDoc
// block whose tags carry descriptions — a bare `@param count` tag is no more
// useful to a caller than no block at all. A baked config cannot read the
// consumer's .defined.json, so the eslint step forwards an override as
// DEFINED_ESLINT_REQUIRE_JSDOC: "off" drops the whole requirement, anything
// else (or unset) keeps the house floor. A repo-owned config never sees this —
// it governs itself.
function requireJsdocFromEnv() {
    return process.env.DEFINED_ESLINT_REQUIRE_JSDOC !== "off";
}

const requireJsdoc = requireJsdocFromEnv();

// Test files are exempt from the complexity ceiling and the documentation
// floor: complexity gates production logic, and a linear test script (a table
// of cases, a fixture driver) is not a design smell. Sonar takes the same
// view — it does not gate complexity or docs on test code either.
const TEST_FILES = ["**/*.test.*", "**/*.spec.*"];

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

// The JSDoc contexts the documentation floor cares about (see the oracle
// notes in standards/node-eslint.md):
// - exported function declarations, arrow functions and function expressions
//   (publicOnly export tracking — inline callbacks stay exempt);
// - class members via `MethodDefinition` (methods and accessors) and
//   `PropertyDefinition` (fields): `MethodDefinition` needs `FunctionExpression`
//   also listed or a documented method's block does not attach;
// - interface members: `TSMethodSignature`/`TSPropertySignature` are reported
//   regardless of the interface's own export marker (the plugin does not walk
//   to the enclosing export) — documented shapes stay clean, so the practical
//   cost is documenting the shape once;
// - `require-description` covers the same declaration forms that require a
//   block, so an EMPTY block is a finding everywhere a block is required
//   (`ExportNamedDeclaration:not(Program)` spans the export-node cases).
const FUNCTION_CONTEXTS = [
    "FunctionDeclaration",
    "ArrowFunctionExpression",
    "FunctionExpression",
];

const JSDOC_RULES = {
    "jsdoc/require-jsdoc": [
        "error",
        {
            publicOnly: { cjs: true, esm: true },
            contexts: [
                ...FUNCTION_CONTEXTS,
                "MethodDefinition",
                "PropertyDefinition",
                "TSMethodSignature",
                "TSPropertySignature",
            ],
            // Docs are written, never manufactured (2026-10-03 finding: with
            // fixers on, comply's repair pass filled the gate's own tree with
            // empty `@param root0` stubs that passed the check). enableFixer
            // exists on every fixable rule in the floor.
            enableFixer: false,
        },
    ],
    // A recorded @param name must match the signature — `require-param-name`
    // only checks the tag HAS a name; stale or wrong names satisfy it.
    // (2026-10-03 review: `@param typo` for `value` passed the floor.)
    "jsdoc/check-param-names": ["error", { enableFixer: false }],
    "jsdoc/require-param-description": "error",
    "jsdoc/require-param-name": "error",
    "jsdoc/require-returns-description": "error",
    "jsdoc/require-description": [
        "error",
        {
            contexts: [
                "ExportNamedDeclaration:not(Program)",
                "ExportDefaultDeclaration",
                "MethodDefinition",
                "PropertyDefinition",
                "TSMethodSignature",
                "TSPropertySignature",
            ],
        },
    ],
};

// The whole JSDoc block as "off" (anything dropping the floor also drops the
// bare-tag blocks), spelled out so eslint-config-prettier does not need to know
// these rules exist.
const JSDOC_OFF = Object.fromEntries(
    Object.keys(JSDOC_RULES).map((rule) => [rule, "off"]),
);

export default [
    {
        files: LINT_FILES,
        // Only typescript-eslint's parser is used in v1: it is needed to see the
        // AST of a .ts/.mts file at all. Its rules are deferred to v2.
        languageOptions: { parser: tseslint.parser },
        plugins: { regexp, jsdoc },
        rules: {
            // 2026-09-26: v1 floor. no-super-linear-move is the rule that
            // catches the motivating system-config spelling
            // /\[[^\]]*\]\(([^)]*)\)/g (fixed in its PR #62); the sibling
            // no-super-linear-backtracking covers the classic exponential cases.
            "regexp/no-super-linear-backtracking": "error",
            "regexp/no-super-linear-move": "error",
            // 2026-10-01: the cyclomatic-complexity floor (see the header).
            ...(complexityMax === null
                ? {}
                : { complexity: ["error", { max: complexityMax }] }),
            // 2026-10-03: the public-API documentation floor (see the header
            // and FUNCTION_CONTEXTS above).
            ...(requireJsdoc ? JSDOC_RULES : {}),
        },
    },
    // Test files keep the house rules but not the complexity ceiling or the
    // documentation floor: a linear test script (a table of cases, a fixture
    // driver) is not a design smell, and undocumented test-only helpers are
    // not surface a future consumer calls into (see TEST_FILES above). Later
    // objects override earlier ones for matching files; prettier stays last.
    { files: TEST_FILES, rules: { complexity: "off", ...JSDOC_OFF } },
    // eslint-config-prettier must be last: formatting is prettier's job, so
    // switch off every ESLint rule that would fight it.
    { ...prettierConfig, files: LINT_FILES },
];
