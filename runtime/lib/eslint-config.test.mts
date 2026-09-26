// Tests for lib/eslint-config.mts: consumer ESLint config discovery.
// Run: node --test lib/eslint-config.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    CONSUMER_ESLINT_CONFIGS,
    ESLINT_EXAMPLE_NAME,
    hasConsumerEslintConfig,
} from "./eslint-config.mts";

test("CONSUMER_ESLINT_CONFIGS is the flat-config name set", () => {
    assert.deepEqual(
        [...CONSUMER_ESLINT_CONFIGS],
        [
            "eslint.config.js",
            "eslint.config.mjs",
            "eslint.config.cjs",
            "eslint.config.ts",
            "eslint.config.mts",
            "eslint.config.cts",
        ],
    );
});

test("hasConsumerEslintConfig finds a root config of any flat-config name", () => {
    assert.equal(
        hasConsumerEslintConfig({ files: ["eslint.config.mjs"] }),
        true,
    );
    assert.equal(
        hasConsumerEslintConfig({
            files: ["eslint.config.ts", "src/a.ts"],
        }),
        true,
    );
});

test("hasConsumerEslintConfig ignores nested configs and the example sidecar", () => {
    assert.equal(
        hasConsumerEslintConfig({ files: ["packages/x/eslint.config.mjs"] }),
        false,
    );
    assert.equal(
        hasConsumerEslintConfig({ files: [ESLINT_EXAMPLE_NAME] }),
        false,
    );
});

test("hasConsumerEslintConfig is false with no config", () => {
    assert.equal(
        hasConsumerEslintConfig({ files: ["package.json", "src/a.ts"] }),
        false,
    );
    assert.equal(hasConsumerEslintConfig({ files: [] }), false);
});
