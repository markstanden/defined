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
// The floor grows deliberately over time: the super-linear-regex floor that
// motivated the step (the local reproduction of Sonar typescript:S8786), the
// cyclomatic-complexity floor, the public-API documentation floor, and then
// (2026-10-12) the core @eslint/js and typescript-eslint *recommended* sets
// plus the naming-convention rule — the latter two ported from
// opencode-docs-plugin's repo config so that repo (and any repo like it) can
// drop its own eslint.config.*. Add rules as they earn their place, and date
// each addition. A repo is expected to be brought into line rather than the
// floor held back; a rule with a per-repo tunable carries an env-door opt-out
// (see below) for a deliberate, temporary exception.
//
// Canonical copy:
// https://github.com/markstanden/defined/blob/main/runtime/config/eslint.config.mjs
import js from "@eslint/js";
import globals from "globals";
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

// The recommended sets (2026-10-12): core @eslint/js plus the
// typescript-eslint set, the latter ported from opencode-docs-plugin's repo
// config. A baked config cannot read the consumer's .defined.json, so the
// eslint step forwards an override as DEFINED_ESLINT_RECOMMENDED: "off" drops
// both sets, anything else (or unset) keeps them. The door is for a deliberate,
// temporary exception, not a way to stay loose. A repo-owned config never sees
// this — it governs itself.
function recommendedFromEnv() {
    return process.env.DEFINED_ESLINT_RECOMMENDED !== "off";
}

const recommended = recommendedFromEnv();

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

// The naming floor (2026-10-12): the reference implementation named in
// standards/naming/typescript.md, ported from opencode-docs-plugin's repo
// config. Selector order matters — a later, more specific selector wins — and
// the looser property/typeProperty forms cover wire-format and env-var names,
// and the docs convention's PascalCase front-matter keys (Area/Keywords/
// Summary). `requiresQuotes` clears the format for a quoted object key (a path
// literal as a key is not an identifier to style).
//
// Oracle notes (ESLint 10.12.0 / typescript-eslint 8.71.1 / @typescript-eslint
// parser 6.0.3, 2026-10-12) follow the jsdoc floor's shape; see
// standards/node-eslint.md.
const NAMING_CONVENTION = {
    "@typescript-eslint/naming-convention": [
        "error",
        {
            selector: "default",
            format: ["camelCase"],
            leadingUnderscore: "allow",
        },
        { selector: "variable", format: ["camelCase", "UPPER_CASE"] },
        // An import binding names a value OR a type. Without this selector the
        // `variable` format applies and every PascalCase class/component import
        // fails — a rule defect, not a code smell (2026-10-12 oracle).
        { selector: "import", format: ["camelCase", "PascalCase"] },
        { selector: "function", format: ["camelCase"] },
        { selector: "typeLike", format: ["PascalCase"] },
        {
            selector: "property",
            format: ["camelCase", "UPPER_CASE", "snake_case", "PascalCase"],
        },
        {
            selector: "typeProperty",
            format: ["camelCase", "snake_case", "PascalCase"],
        },
        // Quoted keys are data, not identifiers: a path literal or a wire event
        // name (`"session.created"`) carries no style to enforce. The modifier
        // must be repeated per key-bearing selector — `property` alone does not
        // cover object-literal members (2026-10-12 oracle).
        {
            selector: "property",
            modifiers: ["requiresQuotes"],
            format: null,
        },
        {
            selector: "objectLiteralProperty",
            modifiers: ["requiresQuotes"],
            format: null,
        },
        {
            selector: "objectLiteralMethod",
            modifiers: ["requiresQuotes"],
            format: null,
        },
    ],
};

// Tool-config files are not source: a rule key such as
// "@typescript-eslint/naming-convention" is data, not an identifier to style.
// Declaration files describe shapes dictated by a framework or library (e.g.
// Astro's ambient `const Component`), so their identifiers are not the repo's
// to rename (2026-10-12 oracle).
const NAMING_EXEMPT_FILES = ["*.config.{mjs,ts,mts}", "**/*.d.ts"];

export default [
    // 2026-10-12: the recommended sets, behind the one
    // DEFINED_ESLINT_RECOMMENDED door. Core @eslint/js first, then
    // typescript-eslint's — its eslint-recommended overrides switch off the
    // core rules that duplicate or conflict for TS. Spread first so the
    // floor's own rules below win on conflict; `prettierConfig` still last.
    ...(recommended ? [js.configs.recommended] : []),
    ...(recommended ? tseslint.configs.recommended : []),
    {
        files: LINT_FILES,
        // typescript-eslint's parser sees the AST of a .ts/.mts file at all;
        // its plugin is registered here too (the recommended base registers it
        // globally) so the naming rule works even when the set is opted out.
        // Node's ambient globals (process, console, module, require…) so the
        // core no-undef rule does not flag them in .js/.mjs/.cjs; TS files need
        // no map — typescript-eslint switches no-undef off for TS and the
        // compiler does the checking (2026-10-12).
        languageOptions: { parser: tseslint.parser, globals: globals.node },
        plugins: { regexp, jsdoc, "@typescript-eslint": tseslint.plugin },
        rules: {
            // 2026-09-26: the regexp floor. no-super-linear-move is the rule
            // that catches the motivating system-config spelling
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
            // 2026-10-12: the naming floor (see NAMING_CONVENTION above).
            ...NAMING_CONVENTION,
            // 2026-10-12: the naming rule allows a leading underscore, so an
            // intentionally-unused binding may carry one (`_input`); without
            // this the recommended no-unused-vars flags it (2026-10-12 oracle,
            // system-config).
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
        },
    },
    // Tool-config and declaration files keep every other floor rule but not
    // naming (see NAMING_EXEMPT_FILES above).
    {
        files: NAMING_EXEMPT_FILES,
        rules: { "@typescript-eslint/naming-convention": "off" },
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
