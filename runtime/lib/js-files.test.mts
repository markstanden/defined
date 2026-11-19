// Tests for lib/js-files.mts: the shared JS/TS extension boundary.
// Run: node --test runtime/lib/js-files.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    filterJsTsFiles,
    hasJsTsExtension,
    JS_TS_EXTENSIONS,
} from "./js-files.mts";

test("hasJsTsExtension accepts every advertised extension", () => {
    // Arrange
    const files = JS_TS_EXTENSIONS.map((extension) => `lib/file.${extension}`);

    // Act
    const actual = files.map((file) => hasJsTsExtension({ file }));

    // Assert
    assert.deepEqual(
        actual,
        JS_TS_EXTENSIONS.map(() => true),
    );
});

test("hasJsTsExtension rejects an unsupported extension, a missing dot and uppercase", () => {
    // Arrange
    const files = ["lib/file.py", "lib/no-extension", "lib/file.TS"];

    // Act
    const actual = files.map((file) => hasJsTsExtension({ file }));

    // Assert
    assert.deepEqual(actual, [false, false, false]);
});

test("filterJsTsFiles keeps the parseable files in inventory order", () => {
    // Arrange
    const files = ["lib/b.mts", "README.md", "lib/a.ts", "lib/no-dot"];

    // Act
    const actual = filterJsTsFiles({ files });

    // Assert
    assert.deepEqual(actual, ["lib/b.mts", "lib/a.ts"]);
});
