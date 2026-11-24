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

test("does not read rule-like text inside a same-line fixture string", () => {
    // Arrange
    const contents = [
        '    const text = "expect(1).toBe(1);";',
        '    const fixture = "// expect(x).toBe(1);";',
    ].map(
        (line) =>
            `${NODE_IMPORT}it("works", () => {\n${line}\n    expect(value).toBe(1);\n});`,
    );

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

test("reports a test whose body holds no assertion call", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", () => {\n    setup();\n});`;

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "no-assertions", line: 2 }],
    );
    assert.match(findings[0]?.message ?? "", /works/u);
});

test("counts each assertion shape as an assertion", () => {
    // Arrange
    const calls = [
        "expect(value).toBe(1);",
        "assert.equal(value, 1);",
        "assertOk(value);",
        "shouldMatch(value);",
    ].map((call) => `${NODE_IMPORT}it("works", () => {\n    ${call}\n});`);

    // Act
    const found = calls.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found,
        calls.map(() => []),
    );
});

test("does not count a lookalike call as an assertion", () => {
    // Arrange
    const calls = [
        "expected(value);",
        "assertion(value);",
        "shoulder(value);",
    ].map((call) => `${NODE_IMPORT}it("works", () => {\n    ${call}\n});`);

    // Act
    const found = calls.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found.map((findings) => findings.map((finding) => finding.rule)),
        calls.map(() => ["no-assertions"]),
    );
});

test("leaves a skipped declaration to the skip defect", () => {
    // Arrange
    const contents = [
        `${NODE_IMPORT}it.skip("works", () => {});`,
        `${NODE_IMPORT}// parked: #123\nit.skip("works", () => {});`,
    ];

    // Act
    const found = contents.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found.map((findings) => findings.map((finding) => finding.rule)),
        [["skipped-test"], []],
    );
});

test("does not report a declaration with no delimited body", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", setup);`;

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("counts an assertion nested inside a block", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", () => {\n` +
        "    if (ready) {\n" +
        "        expect(value).toBe(1);\n" +
        "    }\n" +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("reports an unawaited rejects assertion at its statement line", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", async () => {\n` +
        "    const sut = build();\n" +
        "    expect(sut.run()).rejects.toThrow();\n" +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "unawaited-async-assertion", line: 4 }],
    );
    assert.match(
        findings[0]?.message ?? "",
        /rejects\.toThrow|neither awaited nor returned/u,
    );
});

test("stays silent when the assertions await or return the call", () => {
    // Arrange
    const statements = [
        "await expect(sut.run()).rejects.toThrow();",
        "return expect(sut.run()).rejects.toThrow();",
    ].map(
        (statement) =>
            `${NODE_IMPORT}it("works", async () => {\n    ${statement}\n});`,
    );

    // Act
    const found = statements.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found,
        statements.map(() => []),
    );
});

test("stays silent for an expression-arrow body", () => {
    // Arrange
    const content = `${NODE_IMPORT}it("works", () => expect(sut.run()).rejects.toThrow());`;

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("does not read a rejects assertion in a comment or string", () => {
    // Arrange
    const cases = [
        {
            line: "// expect(sut.run()).rejects.toThrow();",
            rules: ["commented-out-assertion"],
        },
        {
            line: 'const text = "expect(sut.run()).rejects.toThrow();";',
            rules: [],
        },
    ];

    // Act
    const found = cases.map((row) =>
        reviewTestSources([
            {
                path: "a.test.ts",
                content: `${NODE_IMPORT}it("works", () => {\n    ${row.line}\n    expect(value).toBe(1);\n});`,
            },
        ]),
    );

    // Assert
    assert.deepEqual(
        found.map((findings) => findings.map((finding) => finding.rule)),
        cases.map((row) => row.rules),
    );
});

test("does not inherit an await from an earlier statement", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", async () => {\n` +
        "    await sut.ready();\n" +
        "    expect(sut.run()).rejects.toThrow();\n" +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["unawaited-async-assertion"],
    );
});

test("reports an empty catch in a test body", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", () => {\n` +
        "    expect(sut.ready).toBe(true);\n" +
        "    try {\n" +
        "        sut.run();\n" +
        "    } catch (error) {\n" +
        "    }\n" +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "swallowed-exception", line: 6 }],
    );
    assert.match(findings[0]?.message ?? "", /catch \(error\)/u);
});

test("stays silent when the catch asserts or rethrows", () => {
    // Arrange
    const bodies = [
        "    } catch (error) {\n        expect(error).toBeDefined();\n    }",
        "    } catch (error) {\n        throw error;\n    }",
        "    } catch {\n        throw;\n    }",
    ].map(
        (body) =>
            `${NODE_IMPORT}it("works", () => {\n` +
            "    expect(sut.ready).toBe(true);\n" +
            "    try {\n" +
            "        sut.run();\n" +
            `${body}\n` +
            "});",
    );

    // Act
    const found = bodies.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found,
        bodies.map(() => []),
    );
});

test("stays silent for a flag set in the catch and asserted afterwards", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", () => {\n` +
        "    let threw = false;\n" +
        "    try {\n" +
        "        sut.run();\n" +
        "    } catch (error) {\n" +
        "        threw = true;\n" +
        "    }\n" +
        "    expect(threw).toBe(true);\n" +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("reports a catch that only logs", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", () => {\n` +
        "    expect(sut.ready).toBe(true);\n" +
        "    try {\n" +
        "        sut.run();\n" +
        "    } catch (error) {\n" +
        "        console.error(error);\n" +
        "    }\n" +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["swallowed-exception"],
    );
});

test("does not treat a promise catch callback as a catch block", () => {
    // Arrange
    const content =
        `${NODE_IMPORT}it("works", () => {\n` +
        "    expect(sut.ready).toBe(true);\n" +
        "    return sut.run().catch(() => {});\n" +
        "});";

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("does not read a catch block in a comment or string", () => {
    // Arrange
    const lines = [
        "// } catch (error) { }",
        'const text = "} catch (error) { }";',
    ].map(
        (line) =>
            `${NODE_IMPORT}it("works", () => {\n    ${line}\n    expect(value).toBe(1);\n});`,
    );

    // Act
    const found = lines.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found,
        lines.map(() => []),
    );
});
