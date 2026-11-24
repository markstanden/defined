// Tests for lib/test-review/rules.mts: the always-on focused-declaration pair.
// Run: node --test runtime/lib/test-review/rules.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewTestSources } from "./rules.mts";

const NODE_IMPORT = 'import { it } from "node:test";\n';

test("reports a focused test declaration with its marker", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: 'it.only("works", () => {});',
    };

    // Act
    const findings = reviewTestSources([source]);

    // Assert
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, "focused-test");
    assert.equal(findings[0]?.file, "a.test.ts");
    assert.equal(findings[0]?.line, 1);
    assert.match(findings[0]?.message ?? "", /it\.only/u);
});

test("stays silent when the declaration is not focused", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: 'test("works", () => {});',
    };

    // Act
    const findings = reviewTestSources([source]);

    // Assert
    assert.deepEqual(findings, []);
});

test("reports every focused-suite marker", () => {
    // Arrange
    const markers = [
        'describe.only("suite", () => {});',
        'suite.only("suite", () => {});',
        'fdescribe("suite", () => {});',
        'fsuite("suite", () => {});',
    ];

    // Act
    const found = markers.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found.map(([finding]) =>
            finding === undefined
                ? null
                : {
                      rule: finding.rule,
                      file: finding.file,
                      line: finding.line,
                  },
        ),
        markers.map(() => ({
            rule: "focused-suite",
            file: "a.test.ts",
            line: 1,
        })),
    );
    assert.ok(
        found.every(([finding]) =>
            /every other suite/u.test(finding?.message ?? ""),
        ),
    );
});

test("does not report non-declaration focus-like occurrences", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content:
            'const text = "describe.only(";\n' +
            '// it.only("works")\n' +
            '/* describe.only("suite") */\n' +
            "builder.only(1);\n",
    };

    // Act
    const findings = reviewTestSources([source]);

    // Assert
    assert.equal(findings.length, 0);
});

test("reports the line the focused declaration sits on", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: '\n\ntest.only("works", () => {});',
    };

    // Act
    const findings = reviewTestSources([source]);

    // Assert
    assert.equal(findings[0]?.line, 3);
});

test("keeps scanning after an escaped quote inside a literal", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content:
            'const text = "a \\" it.only";\n' + 'test.only("works", () => {});',
    };

    // Act
    const findings = reviewTestSources([source]);

    // Assert
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.line, 2);
});

test("masks a multi-line template literal", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content:
            "const text = `describe.only(\n" +
            "still text`;\n" +
            'test.only("works", () => {});',
    };

    // Act
    const findings = reviewTestSources([source]);

    // Assert
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.line, 3);
});

test("masks a trailing escape to the end of the source", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: 'const text = "abc\\',
    };

    // Act
    const findings = reviewTestSources([source]);

    // Assert
    assert.equal(findings.length, 0);
});

test("orders findings by file, then line, then rule", () => {
    // Arrange
    const sources = [
        {
            path: "b.test.ts",
            content:
                'fdescribe("suite", () => {});\ntest.only("works", () => {});',
        },
        {
            path: "a.test.ts",
            content:
                'test.only("works", () => {}); fdescribe("suite", () => {});',
        },
    ];

    // Act
    const found = reviewTestSources(sources);

    // Assert
    assert.deepEqual(
        found.map(
            (finding) => `${finding.file}:${finding.line}:${finding.rule}`,
        ),
        [
            "a.test.ts:1:focused-suite",
            "a.test.ts:1:focused-test",
            "b.test.ts:1:focused-suite",
            "b.test.ts:2:focused-test",
        ],
    );
});

test("does not read a focus marker split across lines (documented ceiling)", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content:
            'it\n  .only("works", () => {});\n\ntest.only("next", () => {});',
    };

    // Act
    const findings = reviewTestSources([source]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.line),
        [4],
    );
});

test("reports a focused specify declaration at its line", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: '\nspecify.only("works", () => {});',
    };

    // Act
    const findings = reviewTestSources([source]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "focused-test", line: 2 }],
    );
});

test("reports every unparked skip marker", () => {
    // Arrange
    const markers = ["it.skip", "test.todo", "specify.skip"];

    // Act
    const found = markers.map((marker) =>
        reviewTestSources([
            {
                path: "a.test.ts",
                content: `${NODE_IMPORT}${marker}("works", () => {});`,
            },
        ]),
    );

    // Assert
    assert.deepEqual(
        found.map(([finding]) => ({
            rule: finding?.rule,
            line: finding?.line,
        })),
        markers.map(() => ({ rule: "skipped-test", line: 2 })),
    );
    assert.match(found[0]?.[0]?.message ?? "", /it\.skip/u);
});

test("stays silent for each ticket shape beside a skip", () => {
    // Arrange
    const contents = [
        `// parked: #123\nit.skip("works", () => {});`,
        '// blocked on PROJ-42\nit.skip("works", () => {});',
        'it.skip("works #42", () => {});',
        `// see https://example.test/issues/7\nit.skip("works", () => {});`,
        '/* parked: #123 */\nit.skip("works", () => {});',
    ].map((body) => NODE_IMPORT + body);

    // Act
    const found = contents.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found,
        contents.map(() => []),
    );
});

test("reports a skip whose ticket sits beyond a blank line", () => {
    // Arrange
    const content = `${NODE_IMPORT}// parked: #123\n\nit.skip("works", () => {});`;

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["skipped-test"],
    );
});

test("reports a literal compared with itself", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", () => {\n    expect(3).toBe(3);\n});`;

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, "literal-tautology");
    assert.equal(findings[0]?.line, 3);
    assert.match(findings[0]?.message ?? "", /same literal/u);
});

test("reports an expression compared with itself", () => {
    // Arrange
    const contents = [
        "expect(result).toBe(result);",
        "expect(result).toEqual(result);",
        "expect(response.body).toBe(response.body);",
    ].map((call) => `${NODE_IMPORT}it("works", () => {\n    ${call}\n});`);

    // Act
    const found = contents.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found.map((findings) => findings.map((finding) => finding.rule)),
        contents.map(() => ["literal-tautology"]),
    );
    assert.match(found[0]?.[0]?.message ?? "", /same expression/u);
});

test("reports one finding for a boolean literal compared with itself", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", () => {\n    expect(true).toBe(true);\n});`;

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["literal-tautology"],
    );
});

test("leaves different operands alone", () => {
    // Arrange
    const contents = [
        "expect(actual).toBe(expected);",
        "expect(3).toBe(4);",
    ].map((call) => `${NODE_IMPORT}it("works", () => {\n    ${call}\n});`);

    // Act
    const found = contents.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found,
        contents.map(() => []),
    );
});

test("does not report a tautology quoted inside a string", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", () => {\n    const text = "expect(1).toBe(1);";\n});`;

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("reports a tautology on the assertion's own line", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", () => {\n` +
        "    const expected = 3;\n" +
        "    expect(3).toBe(3);\n" +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.line),
        [4],
    );
});

test("stays silent for a declaration with no delimited body", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", setup);`;

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("reports an assertion left in a line comment", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", () => {\n` +
        "    // expect(result).toBe(1);\n" +
        "    expect(result).toBe(2);\n" +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "commented-out-assertion", line: 3 }],
    );
    assert.match(findings[0]?.message ?? "", /expect\(result\)\.toBe\(1\)/u);
});

test("reports an assertion left in a block comment", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", () => {\n` +
        "    /* expect(value).toBe(1); */\n" +
        "    expect(value).toBe(2);\n" +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["commented-out-assertion"],
    );
});

test("does not report a comment-led line with no assertion call", () => {
    // Arrange
    const comments = [
        "// Act & Assert",
        "// expects the value to be normalised",
    ].map(
        (comment) =>
            `${NODE_IMPORT}it("works", () => {\n    ${comment}\n    expect(value).toBe(2);\n});`,
    );

    // Act
    const found = comments.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found,
        comments.map(() => []),
    );
});

test("does not read comment-like text inside a same-line fixture string", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", () => {\n` +
        '    const fixture = "// expect(x).toBe(1);";\n' +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(findings, []);
});
