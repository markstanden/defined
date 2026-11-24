// Tests for lib/glob.mts: the shared consumer-selector glob dialect.
// Run: node --test runtime/lib/glob.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { globToRegExp, isGlob, matchesGlob } from "./glob.mts";

test("isGlob is false for an exact path and true for either wildcard", () => {
    // Arrange
    const selectors = ["src/a.ts", "src/*.ts", "src/?.ts", "src/a(1).ts"];

    // Act
    const actual = selectors.map((selector) => isGlob(selector));

    // Assert
    assert.deepEqual(actual, [false, true, true, false]);
});

test("matchesGlob compares an exact selector literally", () => {
    // Arrange
    const selector = "src/a.ts";

    // Act
    const actual = ["src/a.ts", "src/b.ts", "src/sub/a.ts"].map((file) =>
        matchesGlob({ selector, file }),
    );

    // Assert
    assert.deepEqual(actual, [true, false, false]);
});

test("matchesGlob treats a single star as one path segment", () => {
    // Arrange
    const selector = "src/*.ts";

    // Act
    const actual = ["src/a.ts", "src/nested/b.ts", "src/a.js"].map((file) =>
        matchesGlob({ selector, file }),
    );

    // Assert
    assert.deepEqual(actual, [true, false, false]);
});

test("matchesGlob lets **/ span zero or more directories", () => {
    // Arrange
    const selector = "src/**/index.ts";

    // Act
    const actual = ["src/index.ts", "src/a/index.ts", "src/a/b/index.ts"].map(
        (file) => matchesGlob({ selector, file }),
    );

    // Assert
    assert.deepEqual(actual, [true, true, true]);
});

test("matchesGlob anchors the pattern at both ends", () => {
    // Arrange
    const selector = "src/a.ts";

    // Act
    const actual = ["xsrc/a.ts", "src/a.ts.bak", "src/a.ts"].map((file) =>
        matchesGlob({ selector, file }),
    );

    // Assert
    assert.deepEqual(actual, [false, false, true]);
});

test("matchesGlob matches ? against exactly one non-separator character", () => {
    // Arrange
    const selector = "src/?.ts";

    // Act
    const actual = ["src/a.ts", "src/ab.ts", "src//.ts"].map((file) =>
        matchesGlob({ selector, file }),
    );

    // Assert
    assert.deepEqual(actual, [true, false, false]);
});

test("matchesGlob escapes regular-expression metacharacters", () => {
    // Arrange
    const selector = "src/a(1)+[x].ts";

    // Act
    const actual = ["src/a(1)+[x].ts", "src/a1+x.ts", "src/aa+[x].ts"].map(
        (file) => matchesGlob({ selector, file }),
    );

    // Assert
    assert.deepEqual(actual, [true, false, false]);
});

test("globToRegExp compiles a trailing ** to match any depth", () => {
    // Arrange
    const pattern = "terraform/**";

    // Act
    const actual = [
        "terraform/main.tf",
        "terraform/modules/net/main.tf",
        "pipelines/main.tf",
    ].filter((file) => globToRegExp(pattern).test(file));

    // Assert
    assert.deepEqual(actual, [
        "terraform/main.tf",
        "terraform/modules/net/main.tf",
    ]);
});
