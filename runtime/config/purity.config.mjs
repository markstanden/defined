// Purity/CQS config — baked in runtime/config/ and selected by the purity step
// with an explicit --config. The step owns file selection, so this config is
// intentionally blind to the consumer's own eslint.config.*, ignores and inline
// disable comments: it runs the pinned parser and only the four local rules.
//
// The per-file policy travels through DEFINED_PURITY_POLICY (JSON produced by
// lib/purity.mts), because a baked config cannot read the consumer's
// .defined.json. Each rule looks its own file up by exact repo-relative path;
// ESLint's `files` globbing is deliberately not used for selection.
//
// Canonical copy:
// https://github.com/markstanden/defined/blob/main/runtime/config/purity.config.mjs

import tseslint from "typescript-eslint";

import {
    cqsCommandRule,
    cqsQueryRule,
    cqsTargetsRule,
    pureModuleRule,
} from "./purity-rules.mjs";

// Every advertised JS/TS extension is configured explicitly (the step filters
// the git inventory to the same set in lib/js-files.mts).
const PURITY_FILES = [
    "**/*.js",
    "**/*.mjs",
    "**/*.cjs",
    "**/*.jsx",
    "**/*.ts",
    "**/*.mts",
    "**/*.cts",
    "**/*.tsx",
];

function policyFromEnv() {
    const raw = process.env.DEFINED_PURITY_POLICY;
    if (raw === undefined || raw === "") {
        throw new Error(
            "purity: DEFINED_PURITY_POLICY is unset — run the purity step, not eslint directly",
        );
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("purity: DEFINED_PURITY_POLICY is not valid JSON");
    }
    return parsed;
}

const policy = policyFromEnv();
const options = { policy };

export default [
    {
        files: PURITY_FILES,
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                jsx: true,
            },
        },
        plugins: {
            defined: {
                rules: {
                    "pure-module": pureModuleRule,
                    "cqs-command": cqsCommandRule,
                    "cqs-query": cqsQueryRule,
                    "cqs-targets": cqsTargetsRule,
                },
            },
        },
        linterOptions: { reportUnusedDisableDirectives: "off" },
        rules: {
            "defined/pure-module": ["error", options],
            "defined/cqs-targets": ["error", options],
            "defined/cqs-command": ["error", options],
            "defined/cqs-query": ["error", options],
        },
    },
];
