// Tests for lib/scope.mts: narrowing the git inventory to a declared scope.
// Run: node --test runtime/lib/scope.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveScope } from "./scope.mts";

const FILES = [
    "AGENTS.md",
    "src/FunctionAppLoyalty/Program.cs",
    "tests/FunctionAppLoyalty.Tests/ProgramTests.cs",
    "terraform/main.tf",
];

test("resolveScope returns the whole inventory when include is absent", () => {
    // Act
    const actual = resolveScope({ files: FILES });

    // Assert
    assert.deepEqual(actual, FILES);
});

test("resolveScope returns the whole inventory for an empty include list", () => {
    // Act
    const actual = resolveScope({ files: FILES, include: [] });

    // Assert
    assert.deepEqual(actual, FILES);
});

test("resolveScope keeps only matching files in inventory order", () => {
    // Arrange
    const include = ["src/FunctionAppLoyalty/**", "tests/**"];

    // Act
    const actual = resolveScope({ files: FILES, include });

    // Assert
    assert.deepEqual(actual, [
        "src/FunctionAppLoyalty/Program.cs",
        "tests/FunctionAppLoyalty.Tests/ProgramTests.cs",
    ]);
});

test("resolveScope returns nothing when no file matches", () => {
    // Arrange
    const include = ["does/not/exist/**"];

    // Act
    const actual = resolveScope({ files: FILES, include });

    // Assert
    assert.deepEqual(actual, []);
});
