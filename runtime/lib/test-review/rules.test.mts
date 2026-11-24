// Tests for lib/test-review/rules.mts: the always-on focused-declaration pair.
// Run: node --test runtime/lib/test-review/rules.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewTestSources } from "./rules.mts";

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
            content: 'fdescribe("suite", () => {});\ntest.only("works", () => {});',
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
        found.map((finding) => `${finding.file}:${finding.line}:${finding.rule}`),
        [
            "a.test.ts:1:focused-suite",
            "a.test.ts:1:focused-test",
            "b.test.ts:1:focused-suite",
            "b.test.ts:2:focused-test",
        ],
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
