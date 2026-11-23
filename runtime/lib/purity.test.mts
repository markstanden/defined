// Tests for lib/purity.mts: selector matching and git-scope selection.
// Run: node --test runtime/lib/purity.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PurityConfig } from "./config.mts";
import {
    purityPolicyEnv,
    selectPurityPolicy,
    selectorMatches,
} from "./purity.mts";

test("selectorMatches compares an exact path literally", () => {
    // Arrange
    const selector = "lib/system-status.mts";
    const files = [
        "lib/system-status.mts",
        "lib/system-status.mjs",
        "nested/lib/system-status.mts",
    ];

    // Act
    const actual = files.map((file) => selectorMatches({ selector, file }));

    // Assert
    assert.deepEqual(actual, [true, false, false]);
});

test("selectorMatches treats a single star as one path segment", () => {
    // Arrange
    const selector = "lib/*.ts";
    const files = ["lib/a.ts", "lib/a/b.ts", "lib/a.mts"];

    // Act
    const actual = files.map((file) => selectorMatches({ selector, file }));

    // Assert
    assert.deepEqual(actual, [true, false, false]);
});

test("selectorMatches lets **/ span zero or more directories", () => {
    // Arrange
    const selector = "lib/derive/**/*.ts";
    const files = [
        "lib/derive/receipt.ts",
        "lib/derive/nested/receipt.ts",
        "lib/derive/a/b/c/receipt.ts",
        "lib/other/receipt.ts",
    ];

    // Act
    const actual = files.map((file) => selectorMatches({ selector, file }));

    // Assert
    assert.deepEqual(actual, [true, true, true, false]);
});

test("selectorMatches supports a leading ** and a trailing **", () => {
    // Arrange
    const cases: Array<[string, string]> = [
        ["**/*.ts", "a.ts"],
        ["**/*.ts", "x/y/a.ts"],
        ["lib/**", "lib/a/b/c.ts"],
    ];

    // Act
    const actual = cases.map(([selector, file]) =>
        selectorMatches({ selector, file }),
    );

    // Assert
    assert.deepEqual(actual, [true, true, true]);
});

test("selectorMatches supports ? and treats other characters literally", () => {
    // Arrange
    const cases: Array<[string, string]> = [
        ["lib/a?.ts", "lib/ab.ts"],
        ["lib/a?.ts", "lib/a.ts"],
        ["lib/a[1].ts", "lib/a[1].ts"],
        ["lib/a(1).ts", "lib/a(1).ts"],
        ["lib/with space.ts", "lib/with space.ts"],
    ];

    // Act
    const actual = cases.map(([selector, file]) =>
        selectorMatches({ selector, file }),
    );

    // Assert
    assert.deepEqual(actual, [true, false, true, true, true]);
});

test("selectPurityPolicy dedupes overlapping selectors in git order", () => {
    // Arrange
    const config: PurityConfig = {
        pureModules: ["lib/**/*.ts", "lib/a.ts"],
    };
    const files = ["lib/b.ts", "lib/a.ts", "lib/nested/c.ts", "README.md"];

    // Act
    const policy = selectPurityPolicy({ config, files });

    // Assert
    assert.deepEqual(policy.pure, ["lib/b.ts", "lib/a.ts", "lib/nested/c.ts"]);
    assert.deepEqual(policy.cqs, {});
});

test("selectPurityPolicy groups command and query targets by file", () => {
    // Arrange
    const config: PurityConfig = {
        commands: [{ file: "lib/receipts.mts", name: "saveReceipt" }],
        queries: [
            { file: "lib/receipts.mts", name: "readReceipt" },
            { file: "lib/stock.ts", name: "readStock" },
        ],
    };

    // Act
    const policy = selectPurityPolicy({
        config,
        files: ["lib/receipts.mts", "lib/stock.ts"],
    });

    // Assert
    assert.deepEqual(policy.cqs, {
        "lib/receipts.mts": {
            commands: ["saveReceipt"],
            queries: ["readReceipt"],
        },
        "lib/stock.ts": { commands: [], queries: ["readStock"] },
    });
});

test("selectPurityPolicy rejects a selector matching no supported file", () => {
    // Arrange
    const config: PurityConfig = { pureModules: ["lib/missing.ts"] };

    // Act & Assert
    assert.throws(
        () => selectPurityPolicy({ config, files: ["lib/a.ts"] }),
        /pureModules selector "lib\/missing\.ts" matches no supported file in the git scope/u,
    );
});

test("selectPurityPolicy rejects a selector matching only unsupported files", () => {
    // Arrange
    const config: PurityConfig = { pureModules: ["docs/*.md"] };

    // Act & Assert
    assert.throws(
        () =>
            selectPurityPolicy({
                config,
                files: ["docs/readme.md", "lib/a.ts"],
            }),
        /pureModules selector "docs\/\*\.md" matches no supported file in the git scope/u,
    );
});

test("selectPurityPolicy names a selector that only matches outside the content scope", () => {
    // Arrange
    const config: PurityConfig = { pureModules: ["legacy/**"] };

    // Act & Assert
    assert.throws(
        () =>
            selectPurityPolicy({
                config,
                files: ["src/a.mts"],
                allFiles: ["src/a.mts", "legacy/a.mts"],
            }),
        /pureModules selector "legacy\/\*\*" matches only files outside the content scope declared by scope\.include \(e\.g\. "legacy\/a\.mts"\)/u,
    );
});

test("selectPurityPolicy reports a target outside the gated files", () => {
    // Arrange
    const config: PurityConfig = {
        commands: [{ file: "lib/receipts.mts", name: "saveReceipt" }],
    };

    // Act & Assert
    assert.throws(
        () => selectPurityPolicy({ config, files: ["lib/other.mts"] }),
        /purity: command "saveReceipt" is declared in "lib\/receipts\.mts", which is not in the git scope/u,
    );
});

test("selectPurityPolicy names a target declared outside the content scope", () => {
    // Arrange
    const config: PurityConfig = {
        commands: [{ file: "legacy/receipts.mts", name: "saveReceipt" }],
    };

    // Act & Assert
    assert.throws(
        () =>
            selectPurityPolicy({
                config,
                files: ["src/a.mts"],
                allFiles: ["src/a.mts", "legacy/receipts.mts"],
            }),
        /purity: command "saveReceipt" is declared in "legacy\/receipts\.mts", which is outside the content scope declared by scope\.include/u,
    );
});

test("selectPurityPolicy reports a target that is not a parseable file", () => {
    // Arrange
    const config: PurityConfig = {
        commands: [{ file: "docs/notes.md", name: "saveReceipt" }],
    };

    // Act & Assert
    assert.throws(
        () => selectPurityPolicy({ config, files: ["docs/notes.md"] }),
        /purity: command "saveReceipt" is declared in "docs\/notes\.md", which is not a parseable JS\/TS file/u,
    );
});

test("selectPurityPolicy reports a query target outside the gated files", () => {
    // Arrange
    const config: PurityConfig = {
        queries: [{ file: "lib/receipts.mts", name: "readReceipt" }],
    };

    // Act & Assert
    assert.throws(
        () => selectPurityPolicy({ config, files: [] }),
        /purity: query "readReceipt" is declared in "lib\/receipts\.mts", which is not in the git scope/u,
    );
});

test("purityPolicyEnv is stable JSON for the baked rule", () => {
    // Arrange
    const policy = {
        pure: ["lib/a.ts"],
        cqs: { "lib/b.mts": { commands: ["save"], queries: [] } },
    };

    // Act
    const env = purityPolicyEnv({ policy });

    // Assert
    assert.equal(
        env,
        '{"pure":["lib/a.ts"],"cqs":{"lib/b.mts":{"commands":["save"],"queries":[]}}}',
    );
});
