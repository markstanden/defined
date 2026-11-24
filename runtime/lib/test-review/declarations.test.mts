// Tests for lib/test-review/declarations.mts: Jest/Vitest/node:test discovery.
// Run: node --test runtime/lib/test-review/declarations.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { scanTestDeclarations } from "./declarations.mts";

const NODE_IMPORT = 'import { it } from "node:test";\n';

const VITEST_MODIFIERS = `import { describe, it, expect } from "vitest";

describe.only("focused", () => {
  it.skip("skipped", () => {
    expect(true).toBe(true);
  });

  it.only("focused test", () => {
    expect(true).toBe(true);
  });

  it("plain", () => {
    expect(true).toBe(true);
  });
});
`;

test("scanTestDeclarations reports declaration names with their lines", () => {
    // Act
    const declarations = scanTestDeclarations({
        path: "a.test.ts",
        content: VITEST_MODIFIERS,
    });

    // Assert
    assert.deepEqual(
        declarations.map((declaration) => ({
            name: declaration.name,
            line: declaration.line,
        })),
        [
            { name: "skipped", line: 4 },
            { name: "focused test", line: 8 },
            { name: "plain", line: 12 },
        ],
    );
});

test("scanTestDeclarations records each marker as written", () => {
    // Act
    const markers = scanTestDeclarations({
        path: "a.test.ts",
        content: VITEST_MODIFIERS,
    }).map(({ skipped, focused, skipMarker, focusMarker }) => ({
        skipped,
        focused,
        skipMarker,
        focusMarker,
    }));

    // Assert
    assert.deepEqual(markers, [
        {
            skipped: true,
            focused: false,
            skipMarker: "it.skip",
            focusMarker: undefined,
        },
        {
            skipped: false,
            focused: true,
            skipMarker: undefined,
            focusMarker: "it.only",
        },
        {
            skipped: false,
            focused: false,
            skipMarker: undefined,
            focusMarker: undefined,
        },
    ]);
});

test("scanTestDeclarations captures the delimited body at its brace line", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", () => {\n    expect(1).toBe(1);\n});`;

    // Act
    const [declaration] = scanTestDeclarations({
        path: "a.test.ts",
        content,
    });

    // Assert
    assert.equal(declaration?.body, "{\n    expect(1).toBe(1);\n}");
    assert.equal(declaration?.bodyLine, 2);
});

test("scanTestDeclarations masks the body's strings", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", () => {\n    expect(value).toBe("it.only");\n});`;

    // Act
    const [declaration] = scanTestDeclarations({
        path: "a.test.ts",
        content,
    });

    // Assert
    assert.equal(declaration?.maskedBody?.includes("it.only"), false);
});

test("scanTestDeclarations captures an expression-bodied arrow", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", () => expect(1).toBe(1));`;

    // Act
    const [declaration] = scanTestDeclarations({
        path: "a.test.ts",
        content,
    });

    // Assert
    assert.equal(declaration?.body, "expect(1).toBe(1)");
});

test("scanTestDeclarations leaves the body null when a semicolon precedes the brace", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", setup);`;

    // Act
    const [declaration] = scanTestDeclarations({
        path: "a.test.ts",
        content,
    });

    // Assert
    assert.equal(declaration?.body, null);
    assert.equal(declaration?.bodyLine, 2);
});

test("scanTestDeclarations skips declarations with no title", () => {
    // Arrange
    const heads = [
        "it(async () => {});",
        "it(() => {});",
        "it(function () {});",
        "it(...cases);",
        "it(42, () => {});",
    ];

    // Act
    const counts = heads.map(
        (head) =>
            scanTestDeclarations({
                path: "a.test.ts",
                content: NODE_IMPORT + head,
            }).length,
    );

    // Assert
    assert.deepEqual(
        counts,
        heads.map(() => 0),
    );
});

test("scanTestDeclarations ignores test-like text outside code", () => {
    // Arrange
    const content =
        NODE_IMPORT +
        [
            'regex.test("x");',
            'const text = "it.only(\\"works\\", () => {})";',
            '// it.skip("commented", () => {});',
            '/* test.only("block", () => {}); */',
        ].join("\n");

    // Act
    const declarations = scanTestDeclarations({
        path: "a.test.ts",
        content,
    });

    // Assert
    assert.deepEqual(declarations, []);
});

test("scanTestDeclarations detects the file's test framework", () => {
    // Arrange
    const contents = [
        'import { it } from "vitest";\nit("x", () => {});',
        'import { it } from "@jest/globals";\nit("x", () => {});',
        NODE_IMPORT + 'it("x", () => {});',
    ];

    // Act
    const frameworks = contents.map(
        (content) =>
            scanTestDeclarations({ path: "a.test.ts", content })[0]?.framework,
    );

    // Assert
    assert.deepEqual(frameworks, ["vitest", "jest", "node-test"]);
});

test("scanTestDeclarations yields nothing when no framework marker is present", () => {
    // Arrange
    const content = 'it("x", () => {});';

    // Act
    const declarations = scanTestDeclarations({
        path: "a.test.ts",
        content,
    });

    // Assert
    assert.deepEqual(declarations, []);
});

test("scanTestDeclarations reads the three declaration aliases", () => {
    // Arrange
    const content =
        NODE_IMPORT +
        'it("a", () => {});\ntest("b", () => {});\nspecify("c", () => {});';

    // Act
    const names = scanTestDeclarations({
        path: "a.test.ts",
        content,
    }).map((declaration) => declaration.name);

    // Assert
    assert.deepEqual(names, ["a", "b", "c"]);
});

test("scanTestDeclarations keeps a quoted title's punctuation", () => {
    // Arrange
    const content = `${NODE_IMPORT}it('a, "b" (c)', () => {});`;

    // Act
    const [declaration] = scanTestDeclarations({
        path: "a.test.ts",
        content,
    });

    // Assert
    assert.equal(declaration?.name, 'a, "b" (c)');
});
