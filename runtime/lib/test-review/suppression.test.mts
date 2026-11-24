// Tests for lib/test-review/suppression.mts: the why-note grammar and the
// comment block a note must sit in.
// Run: node --test runtime/lib/test-review/suppression.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    commentBlockAbove,
    isVacuous,
    readNote,
    resolveRule,
} from "./suppression.mts";

test("commentBlockAbove collects the contiguous comment lines above a declaration", () => {
    // Arrange
    const content = [
        "// Why use sleep here: the delay proves the polling loop gives up",
        "// second line of the same block",
        'test("works", () => {});',
    ].join("\n");

    // Act
    const block = commentBlockAbove({ content, line: 3 });

    // Assert
    assert.deepEqual(
        block.map((entry) => entry.line),
        [1, 2],
    );
});

test("commentBlockAbove stops at a blank line", () => {
    // Arrange
    const content = [
        "// Why use sleep here: the delay proves the polling loop gives up",
        "",
        'test("works", () => {});',
    ].join("\n");

    // Act
    const block = commentBlockAbove({ content, line: 3 });

    // Assert
    assert.deepEqual(block, []);
});

test("commentBlockAbove stops at a code line and keeps attribute lines", () => {
    // Arrange
    const content = [
        "// Why use sleep here: the delay proves the polling loop gives up",
        "[Fact]",
        "// trailing comment in the attribute block",
        'test("works", () => {});',
        "const after = 1;",
    ].join("\n");

    // Act
    const block = commentBlockAbove({ content, line: 4 });

    // Assert
    assert.deepEqual(
        block.map((entry) => entry.line),
        [1, 2, 3],
    );
});

test("readNote reads both note frames", () => {
    // Arrange
    const lines = [
        "// Why use ambient-clock here: the test pins the formatter's boundary",
        "  * Why not use property: rows are fixed boundary cases",
    ];

    // Act
    const notes = lines.map((text) => readNote(text));

    // Assert
    assert.deepEqual(notes, [
        {
            rule: "ambient-clock",
            reason: "the test pins the formatter's boundary",
        },
        { rule: "property", reason: "rows are fixed boundary cases" },
    ]);
});

test("readNote ignores prose and a note with no colon", () => {
    // Arrange
    const lines = [
        "// Why use a helper here: the helper keeps the test readable",
        "// Why use sleep here",
        "// the sleep is controlled by the fake clock",
    ];

    // Act
    const notes = lines.map((text) => readNote(text));

    // Assert
    assert.deepEqual(notes, [null, null, null]);
});

test("readNote keeps a wrong-case id for the catalogue to reject", () => {
    // Arrange
    const text = "// Why use Ambient-Clock here: the test pins the boundary";

    // Act
    const note = readNote(text);

    // Assert
    assert.equal(note?.rule, "Ambient-Clock");
});

test("resolveRule applies the one documented alias", () => {
    // Arrange
    const rules = ["property", "ambient-clock", "property-trigger-unmet"];

    // Act
    const resolved = rules.map((rule) => resolveRule(rule));

    // Assert
    assert.deepEqual(resolved, [
        "property-trigger-unmet",
        "ambient-clock",
        "property-trigger-unmet",
    ]);
});

test("isVacuous rejects restatements and accepts a statement of control", () => {
    // Arrange
    const reasons = [
        "",
        "legitimate",
        " Intentional. ",
        "by design",
        "todo",
        "n/a",
        "the delay proves the polling loop gives up",
    ];

    // Act
    const vacuous = reasons.map((reason) => isVacuous(reason));

    // Assert
    assert.deepEqual(vacuous, [
        true,
        true,
        true,
        true,
        true,
        true,
        false,
    ]);
});
