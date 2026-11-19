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

    // Act & Assert
    assert.equal(
        selectorMatches({ selector, file: "lib/system-status.mts" }),
        true,
    );
    assert.equal(
        selectorMatches({ selector, file: "lib/system-status.mjs" }),
        false,
    );
    assert.equal(
        selectorMatches({ selector, file: "nested/lib/system-status.mts" }),
        false,
    );
});

test("selectorMatches treats a single star as one path segment", () => {
    // Arrange
    const selector = "lib/*.ts";

    // Act & Assert
    assert.equal(selectorMatches({ selector, file: "lib/a.ts" }), true);
    assert.equal(selectorMatches({ selector, file: "lib/a/b.ts" }), false);
    assert.equal(selectorMatches({ selector, file: "lib/a.mts" }), false);
});

test("selectorMatches lets **/ span zero or more directories", () => {
    // Arrange
    const selector = "lib/derive/**/*.ts";

    // Act & Assert
    assert.equal(
        selectorMatches({ selector, file: "lib/derive/receipt.ts" }),
        true,
    );
    assert.equal(
        selectorMatches({ selector, file: "lib/derive/nested/receipt.ts" }),
        true,
    );
    assert.equal(
        selectorMatches({ selector, file: "lib/derive/a/b/c/receipt.ts" }),
        true,
    );
    assert.equal(
        selectorMatches({ selector, file: "lib/other/receipt.ts" }),
        false,
    );
});

test("selectorMatches supports a leading ** and a trailing **", () => {
    assert.equal(selectorMatches({ selector: "**/*.ts", file: "a.ts" }), true);
    assert.equal(
        selectorMatches({ selector: "**/*.ts", file: "x/y/a.ts" }),
        true,
    );
    assert.equal(
        selectorMatches({ selector: "lib/**", file: "lib/a/b/c.ts" }),
        true,
    );
});

test("selectorMatches supports ? and treats other characters literally", () => {
    // Act & Assert
    assert.equal(
        selectorMatches({ selector: "lib/a?.ts", file: "lib/ab.ts" }),
        true,
    );
    assert.equal(
        selectorMatches({ selector: "lib/a?.ts", file: "lib/a.ts" }),
        false,
    );
    assert.equal(
        selectorMatches({ selector: "lib/a[1].ts", file: "lib/a[1].ts" }),
        true,
    );
    assert.equal(
        selectorMatches({ selector: "lib/a(1).ts", file: "lib/a(1).ts" }),
        true,
    );
    assert.equal(
        selectorMatches({
            selector: "lib/with space.ts",
            file: "lib/with space.ts",
        }),
        true,
    );
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

test("selectPurityPolicy reports a target outside the git scope", () => {
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

test("selectPurityPolicy reports a query target outside the git scope", () => {
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
