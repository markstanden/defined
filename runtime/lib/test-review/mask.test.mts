// Tests for lib/test-review/mask.mts: offset-preserving masking of test source.
// Run: node --test runtime/lib/test-review/mask.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { maskTestSource } from "./mask.mts";

const LENGTH_CASES = [
    "let x = 1;",
    'const a = "text";',
    "const b = 'text';",
    "const c = `text`;",
    "// comment\nconst d = 2;",
    "/* block */ const e = 3;",
    "const g = `multi\nline`;",
    'const h = "open',
];

const MULTI_LINE_CASES = [
    "// comment\nconst d = 2;",
    "const g = `multi\nline`;",
    "a\nb\nc",
];

const QUOTE_CASES = ['"secret"', "'secret'", "`secret`"];

test("maskTestSource preserves the source length", () => {
    // Act
    const lengths = LENGTH_CASES.map(
        (content) => maskTestSource(content).length,
    );

    // Assert
    assert.deepEqual(
        lengths,
        LENGTH_CASES.map((content) => content.length),
    );
});

test("maskTestSource keeps every newline at its original offset", () => {
    // Act
    const newlines = MULTI_LINE_CASES.map((content) =>
        maskTestSource(content).replace(/[^\n]/gu, ""),
    );

    // Assert
    assert.deepEqual(
        newlines,
        MULTI_LINE_CASES.map((content) => content.replace(/[^\n]/gu, "")),
    );
});

test("maskTestSource leaves code outside literals untouched", () => {
    // Act & Assert
    assert.equal(maskTestSource("let x = 1;"), "let x = 1;");
});

test("maskTestSource blanks a quoted literal including its delimiters", () => {
    // Act
    const masked = QUOTE_CASES.map((source) => maskTestSource(source));

    // Assert
    assert.deepEqual(
        masked,
        QUOTE_CASES.map((source) => " ".repeat(source.length)),
    );
});

test("maskTestSource does not let an apostrophe in a comment open a literal", () => {
    // Arrange
    const comments = ["// the repo's report", "/* don't */"];

    // Act
    const masked = comments.map((comment) =>
        maskTestSource(`${comment}\nconst kept = 1;`),
    );

    // Assert
    assert.deepEqual(
        masked,
        comments.map(
            (comment) => `${" ".repeat(comment.length)}\nconst kept = 1;`,
        ),
    );
});

test("maskTestSource keeps comment text verbatim in comments-keep mode", () => {
    // Arrange
    const content = [
        "// the repo's report: \"quoted\" and it.only()",
        'const a = "text"; // trailing note',
        '/* block "fixture" */ const b = 1;',
    ].join("\n");
    const expected = [
        "// the repo's report: \"quoted\" and it.only()",
        `const a = ${" ".repeat(6)}; // trailing note`,
        '/* block "fixture" */ const b = 1;',
    ].join("\n");

    // Act
    const masked = maskTestSource(content, { comments: "keep" });

    // Assert
    assert.equal(masked, expected);
});

test("maskTestSource keeps an apostrophe in a comment from opening a literal in comments-keep mode", () => {
    // Arrange
    const content = "// don't\nconst kept = 1;";

    // Act
    const masked = maskTestSource(content, { comments: "keep" });

    // Assert
    assert.equal(masked, content);
});

test("maskTestSource blanks comments by default", () => {
    // Arrange
    const content = "// note\n/* block */ const b = 1;";

    // Act
    const masked = maskTestSource(content);

    // Assert
    assert.equal(
        masked,
        `${" ".repeat(7)}\n${" ".repeat(11)} const b = 1;`,
    );
});

test("maskTestSource masks an unterminated literal to the end of the source", () => {
    // Arrange
    const content = 'const text = "abc';
    const visible = "const text = ";

    // Act
    const masked = maskTestSource(content);

    // Assert
    assert.equal(masked, visible + " ".repeat(content.length - visible.length));
});

test("maskTestSource blanks a multi-line template literal without moving its newline", () => {
    // Arrange
    const content = "const a = `x\ny`;\nconst b = 2;";

    // Act
    const masked = maskTestSource(content);

    // Assert
    assert.equal(masked, "const a = " + "  \n  ;\nconst b = 2;");
});

test("maskTestSource masks the rest of the source after a quote in a regex literal (documented ceiling)", () => {
    // Arrange
    const content = "const re = /[\"']/;\nconst kept = 1;";
    const visible = "const re = /[";

    // Act
    const masked = maskTestSource(content);

    // Assert
    assert.equal(
        masked.slice(visible.length),
        content.slice(visible.length).replace(/[^\n]/gu, " "),
    );
});

test("maskTestSource masks template interpolation content as literal data (documented ceiling)", () => {
    // Arrange
    const content = "const t = `x ${it.only()} y`;\nconst kept = 1;";

    // Act
    const masked = maskTestSource(content);

    // Assert
    assert.ok(!masked.includes("it.only"));
    assert.ok(masked.endsWith("const kept = 1;"));
});
