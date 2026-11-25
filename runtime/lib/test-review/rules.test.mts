// Tests for lib/test-review/rules.mts: the always-on focused-declaration pair.
// Run: node --test runtime/lib/test-review/rules.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewTestSources } from "./rules.mts";

const NODE_IMPORT = 'import { it } from "node:test";\n';

/** One C# test method wrapped in a class; a `[Fact]` method sits at line 4. */
function xunitMethod(method: string): string {
    return `public class MathTests\n{\n${method}\n}`;
}

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

test("does not read an AAA label as a commented-out assertion", () => {
    // Arrange — "Assert (logging)" names the phase; the space before the
    // bracket makes it a label, not a dead call.
    const content = xunitMethod(
        [
            "    [Fact]",
            "    public void Sends()",
            "    {",
            "        // Arrange",
            "        Queue(new Message());",
            "        // Assert (logging)",
            "        _mock.Verify(l => l.Log(It.IsAny<string>()), Times.Once);",
            "    }",
        ].join("\n"),
    );

    // Act
    const findings = reviewTestSources([{ path: "SenderTests.cs", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("still reports a commented-out assertion with a member call", () => {
    // Arrange — the label exclusion must not hide a real dead assertion.
    const content = xunitMethod(
        [
            "    [Fact]",
            "    public void Adds()",
            "    {",
            "        // Assert.Equal(1, value);",
            "        Sut.Add(value);",
            "        Assert.Equal(2, Sut.Total);",
            "    }",
        ].join("\n"),
    );

    // Act
    const findings = reviewTestSources([{ path: "MathTests.cs", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["commented-out-assertion"],
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

test("counts a generic TestAssert helper as an assertion", () => {
    // Arrange — team helper types ending in Assert are assertion calls too.
    const content = xunitMethod(
        [
            "    [Fact]",
            "    public async Task Transforms()",
            "    {",
            "        var result = await Sut.Transform(input);",
            "        await TestAssert.CustomerXml(result);",
            "    }",
        ].join("\n"),
    );

    // Act
    const findings = reviewTestSources([{ path: "CustomerTests.cs", content }]);

    // Assert
    assert.deepEqual(findings, []);
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
    const contents = [
        "    return sut.run().catch(() => {});",
        "    return sut.run().catch(function (error) { console.error(error); });",
    ].map(
        (line) =>
            `${NODE_IMPORT}it("works", () => {\n` +
            "    expect(sut.ready).toBe(true);\n" +
            `${line}\n` +
            "});",
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

test("keeps the lexical await read (documented ceilings)", () => {
    // Arrange
    const bodies = [
        "    const promise = expect(sut.run()).rejects.toThrow();\n    await promise;",
        "    const check = () => expect(sut.run()).rejects.toThrow();\n    await check();",
    ].map((body) => `${NODE_IMPORT}it("works", async () => {\n${body}\n});`);

    // Act
    const found = bodies.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }]),
    );

    // Assert
    assert.deepEqual(
        found.map((findings) => findings.map((finding) => finding.rule)),
        bodies.map(() => ["unawaited-async-assertion"]),
    );
});

test("reports a C# test whose body holds no assertion", () => {
    // Arrange
    const content = xunitMethod(
        "    [Fact]\n    public void Adds()\n    {\n        Setup();\n    }",
    );

    // Act
    const findings = reviewTestSources([{ path: "MathTests.cs", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "no-assertions", line: 4 }],
    );
});

test("counts each C# assertion shape as an assertion", () => {
    // Arrange
    const bodies = [
        "        Assert.Equal(1, value);",
        "        result.Should().Be(2);",
        "        Should.Throw<Exception>(() => Run());",
        "        mock.Verify(value);",
        "        AssertInvariants(engine);",
        "        Expect(Page).ToHaveTitleAsync(expectedTitle);",
        "        value.ShouldThrow<ArgumentException>();",
        "        result.ShouldBeOfType<UnauthorizedResult>();",
    ].map((line) =>
        xunitMethod(
            `    [Fact]\n    public void Adds()\n    {\n${line}\n    }`,
        ),
    );

    // Act
    const found = bodies.map((content) =>
        reviewTestSources([{ path: "MathTests.cs", content }]),
    );

    // Assert
    assert.deepEqual(
        found,
        bodies.map(() => []),
    );
});

test("reports a theory with no data source", () => {
    // Arrange
    const content = xunitMethod(
        "    [Theory]\n    public void Adds(int a, int b)\n    {\n        Assert.Equal(a + b, Add(a, b));\n    }",
    );

    // Act
    const findings = reviewTestSources([{ path: "MathTests.cs", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "theory-without-data", line: 4 }],
    );
    assert.match(findings[0]?.message ?? "", /zero cases/u);
});

test("stays silent for a theory with inline data", () => {
    // Arrange
    const content = xunitMethod(
        "    [Theory]\n    [InlineData(1, 2)]\n    public void Adds(int a, int b)\n    {\n        Assert.Equal(a + b, Add(a, b));\n    }",
    );

    // Act
    const findings = reviewTestSources([{ path: "MathTests.cs", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("stays silent for a fact", () => {
    // Arrange
    const content = xunitMethod(
        "    [Fact]\n    public void Adds()\n    {\n        Assert.Equal(3, Add(1, 2));\n    }",
    );

    // Act
    const findings = reviewTestSources([{ path: "MathTests.cs", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("parks a C# skip with an annotation reason", () => {
    // Arrange
    const content = xunitMethod(
        '    [Fact(Skip = "flaky until #12")]\n    public void Adds()\n    {\n        Assert.Equal(1, value);\n    }',
    );

    // Act
    const findings = reviewTestSources([{ path: "MathTests.cs", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("reports a C# skip with no annotation reason", () => {
    // Arrange
    const contents = [
        xunitMethod(
            '    [Fact(Skip = "")]\n    public void Adds()\n    {\n        Assert.Equal(1, value);\n    }',
        ),
        xunitMethod(
            "    [Test]\n    [Ignore]\n    public void Adds()\n    {\n        Assert.Equal(1, value);\n    }",
        ),
        xunitMethod(
            '    // parked: #123\n    [Fact(Skip = "")]\n    public void Adds()\n    {\n        Assert.Equal(1, value);\n    }',
        ),
        xunitMethod(
            '    [Test]\n    [Ignore("flaky until CI grid fixed")]\n    public void Adds()\n    {\n        Assert.Equal(1, value);\n    }',
        ),
    ];

    // Act
    const found = contents.map((content) =>
        reviewTestSources([{ path: "MathTests.cs", content }]),
    );

    // Assert
    assert.deepEqual(
        found.map((findings) => findings.map((finding) => finding.rule)),
        [["skipped-test"], ["skipped-test"], [], []],
    );
});

test("reports a C# assertion of a literal against itself", () => {
    // Arrange
    const bodies = [
        "        Assert.Equal(3, 3);",
        "        Assert.True(true);",
    ].map((line) =>
        xunitMethod(
            `    [Fact]\n    public void Adds()\n    {\n${line}\n    }`,
        ),
    );

    // Act
    const found = bodies.map((content) =>
        reviewTestSources([{ path: "MathTests.cs", content }]),
    );

    // Assert
    assert.deepEqual(
        found.map((findings) => findings.map((finding) => finding.rule)),
        bodies.map(() => ["literal-tautology"]),
    );
});

test("leaves different C# operands alone", () => {
    // Arrange
    const content = xunitMethod(
        "    [Fact]\n    public void Adds()\n    {\n        Assert.Equal(actual, expected);\n    }",
    );

    // Act
    const findings = reviewTestSources([{ path: "MathTests.cs", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("reports an unawaited C# async assertion", () => {
    // Arrange
    const methods = [
        "        Assert.ThrowsAsync<ArgumentException>(() => Run());",
        "        await Assert.ThrowsAsync<ArgumentException>(() => Run());",
    ].map((line) =>
        xunitMethod(
            `    [Fact]\n    public async Task Adds()\n    {\n${line}\n    }`,
        ),
    );

    // Act
    const found = methods.map((content) =>
        reviewTestSources([{ path: "MathTests.cs", content }]),
    );

    // Assert
    assert.deepEqual(
        found.map((findings) => findings.map((finding) => finding.rule)),
        [["unawaited-async-assertion"], []],
    );
});

test("leaves a Moq ThrowsAsync setup alone", () => {
    // Arrange — Moq configuration, not an assertion: ThrowsAsync on a Setup
    // chain arranges mock behaviour and needs no await.
    const content = xunitMethod(
        [
            "    [Fact]",
            "    public async Task Sends()",
            "    {",
            '        _mock.Setup(s => s.SendAsync(It.IsAny<string>())).ThrowsAsync(new Exception("boom"));',
            "        await Assert.ThrowsAsync<Exception>(() => Sut.Run());",
            "    }",
        ].join("\n"),
    );

    // Act
    const findings = reviewTestSources([{ path: "SenderTests.cs", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("leaves a generic Moq Setup ThrowsAsync alone", () => {
    // Arrange — the generic and protected shapes carry the mock type between
    // Setup and its argument list, and are still mock configuration.
    const content = xunitMethod(
        [
            "    [Fact]",
            "    public async Task Sends()",
            "    {",
            "        _handler",
            "            .Protected()",
            "            .Setup<Task<HttpResponseMessage>>(",
            '                "SendAsync",',
            "                ItExpr.IsAny<HttpRequestMessage>(),",
            "                ItExpr.IsAny<CancellationToken>()",
            "            )",
            '            .ThrowsAsync(new HttpRequestException("down"));',
            "        await Assert.ThrowsAsync<Exception>(() => Sut.Run());",
            "    }",
        ].join("\n"),
    );

    // Act
    const findings = reviewTestSources([{ path: "HandlerTests.cs", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

/** One node:test declaration whose body holds the given statement. */
function nodeTestBody(statement: string): string {
    return `import { test } from "node:test";\ntest("case", () => {\n    ${statement}\n});`;
}

/** One node:test declaration whose block body holds the given lines. */
function declaredBody(body: string): string {
    return `import { test } from "node:test";\ntest("case", () => {\n${body}\n});`;
}

/** Determinism rule ids, so a review list reads without structure noise. */
const DETERMINISM_IDS = new Set([
    "ambient-clock",
    "sleep",
    "randomness",
    "ambient-environment",
    "ambient-locale",
    "real-network",
    "real-filesystem",
    "process-spawn",
    "debug-output",
]);

/** The determinism rule ids a finding list holds, in report order. */
function reviewRulesOf(
    findings: ReturnType<typeof reviewTestSources>,
): string[] {
    return findings
        .map((finding) => finding.rule)
        .filter((rule) => DETERMINISM_IDS.has(rule));
}

test("reports every determinism rule in review mode and none in tracked mode", () => {
    // Arrange
    const cases = [
        ["ambient-clock", "const now = Date.now();"],
        ["sleep", "await sleep(5);"],
        ["randomness", "const value = Math.random();"],
        ["ambient-environment", "const shell = process.env.SHELL;"],
        ["ambient-locale", "const culture = CultureInfo.CurrentCulture;"],
        ["real-network", "await fetch(url);"],
        ["real-filesystem", "const text = fs.readFileSync(file);"],
        ["process-spawn", "spawn(command);"],
        ["debug-output", "console.log(value);"],
    ] as const;
    const sources = cases.map(([, statement]) => ({
        path: "a.test.ts",
        content: nodeTestBody(statement),
    }));

    // Act
    const found = sources.map((source) => ({
        tracked: reviewRulesOf(reviewTestSources([source])),
        reviewed: reviewRulesOf(reviewTestSources([source], { review: true })),
    }));

    // Assert
    assert.deepEqual(
        found.map((item) => item.tracked),
        cases.map(() => []),
    );
    assert.deepEqual(
        found.map((item) => item.reviewed),
        cases.map(([rule]) => [rule]),
    );
});

test("reports the line and evidence of a determinism lead", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: nodeTestBody("const now = Date.now();"),
    };

    // Act
    const [finding] = reviewTestSources([source], { review: true }).filter(
        (candidate) => candidate.rule === "ambient-clock",
    );

    // Assert
    assert.equal(finding?.line, 3);
    assert.match(finding?.message ?? "", /Date\.now\(/u);
    assert.match(finding?.message ?? "", /when the test ran/u);
});

test("does not report a determinism name quoted inside a string", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: nodeTestBody('const label = "Date.now()";'),
    };

    // Act
    const findings = reviewTestSources([source], { review: true });

    // Assert
    assert.deepEqual(reviewRulesOf(findings), []);
});

/** The structure rule ids a finding list holds. */
function structureRulesOf(
    findings: ReturnType<typeof reviewTestSources>,
): string[] {
    return findings
        .map((finding) => finding.rule)
        .filter(
            (rule) =>
                rule === "missing-structure" || rule === "multi-statement-act",
        );
}

test("accepts a complete Arrange / Act / Assert set", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: declaredBody(
            [
                "    // Arrange",
                "    const x = 1;",
                "    // Act",
                "    const y = x;",
                "    // Assert",
                "    assert.equal(y, 1);",
            ].join("\n"),
        ),
    };

    // Act
    const findings = reviewTestSources([source], { review: true });

    // Assert
    assert.deepEqual(structureRulesOf(findings), []);
});

test("accepts Act and Assert combined under every joiner", () => {
    // Arrange
    const joiners = ["&", "/", ",", " and ", "+"];
    const sources = joiners.map((joiner) => ({
        path: "a.test.ts",
        content: declaredBody(
            [
                "    // Arrange",
                "    const x = 1;",
                `    // Act${joiner}Assert`,
                "    assert.equal(x, 1);",
            ].join("\n"),
        ),
    }));

    // Act
    const found = sources.map((source) =>
        structureRulesOf(reviewTestSources([source], { review: true })),
    );

    // Assert
    assert.deepEqual(
        found,
        joiners.map(() => []),
    );
});

test("requires Arrange when a statement precedes the first label", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: declaredBody(
            [
                "    const total = add(1, 2);",
                "    // Act",
                "    assert.equal(total, 3);",
            ].join("\n"),
        ),
    };

    // Act
    const [finding] = reviewTestSources([source], { review: true }).filter(
        (candidate) => candidate.rule === "missing-structure",
    );

    // Assert
    assert.match(finding?.message ?? "", /found: act\b/u);
    assert.match(finding?.message ?? "", /Act and Assert must be labelled/u);
});

test("does not accept Given / When / Then as a substitute", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: declaredBody(
            [
                "    // Given",
                "    setup();",
                "    // When",
                "    act();",
                "    // Then",
                "    assert.ok(done);",
            ].join("\n"),
        ),
    };

    // Act
    const [finding] = reviewTestSources([source], { review: true }).filter(
        (candidate) => candidate.rule === "missing-structure",
    );

    // Assert
    assert.match(finding?.message ?? "", /found: none/u);
});

test("does not count phase labels quoted inside a fixture string", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: declaredBody(
            [
                "    const fixture = `",
                "    // Arrange",
                "    // Act",
                "    // Assert",
                "    `;",
                "    assert.ok(fixture);",
            ].join("\n"),
        ),
    };

    // Act
    const [finding] = reviewTestSources([source], { review: true }).filter(
        (candidate) => candidate.rule === "missing-structure",
    );

    // Assert
    assert.match(finding?.message ?? "", /found: none/u);
});

test("reads phase labels past apostrophes in line and block comments", () => {
    // Arrange
    const prefixes = ["    // don't skip", "    /* don't skip */"];
    const sources = prefixes.map((prefix) => ({
        path: "a.test.ts",
        content: declaredBody(
            [
                prefix,
                "    // Arrange",
                "    const x = 1;",
                "    // Act",
                "    const y = x + 1;",
                "    // Assert",
                "    assert.equal(y, 2);",
            ].join("\n"),
        ),
    }));

    // Act
    const found = sources.map((source) =>
        structureRulesOf(reviewTestSources([source], { review: true })),
    );

    // Assert
    assert.deepEqual(
        found,
        prefixes.map(() => []),
    );
});

test("reports the phase labels it found when the set is incomplete", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: `import { test } from "node:test";\ntest("adds numbers", () => {\n    // Arrange\n    const x = 1;\n    assert.equal(x, 1);\n});`,
    };

    // Act
    const [finding] = reviewTestSources([source], { review: true }).filter(
        (candidate) => candidate.rule === "missing-structure",
    );

    // Assert
    assert.equal(finding?.line, 2);
    assert.match(finding?.message ?? "", /"adds numbers"/u);
    assert.match(finding?.message ?? "", /found: arrange/u);
});

test("does not count an assertion call or a commented assertion as a label", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: declaredBody(
            ["    // Assert.Equal(1, 1)", "    Assert.Equal(1, 1);"].join("\n"),
        ),
    };

    // Act
    const [finding] = reviewTestSources([source], { review: true }).filter(
        (candidate) => candidate.rule === "missing-structure",
    );

    // Assert
    assert.match(finding?.message ?? "", /found: none/u);
});

test("stays silent for a declaration with no delimited body", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: 'import { test } from "node:test";\ntest("no body", done);',
    };

    // Act
    const findings = reviewTestSources([source], { review: true });

    // Assert
    assert.deepEqual(structureRulesOf(findings), []);
});

test("reports a discrete act region with two statements", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: declaredBody(
            [
                "    // Act",
                "    sut.Start();",
                "    sut.Stop();",
                "    // Assert",
                "    assert.ok(started);",
            ].join("\n"),
        ),
    };

    // Act
    const [finding] = reviewTestSources([source], { review: true }).filter(
        (candidate) => candidate.rule === "multi-statement-act",
    );

    // Assert
    assert.equal(finding?.line, 3);
    assert.match(finding?.message ?? "", /region: Act; statements: 2/u);
});

test("reports a combined region with two statements", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: declaredBody(
            [
                "    // Act & Assert",
                "    capture();",
                "    assert.equal(captured, 1);",
            ].join("\n"),
        ),
    };

    // Act
    const [finding] = reviewTestSources([source], { review: true }).filter(
        (candidate) => candidate.rule === "multi-statement-act",
    );

    // Assert
    assert.match(
        finding?.message ?? "",
        /region: Act & Assert; statements: 2/u,
    );
});

test("counts a multi-line act call as one statement", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content: declaredBody(
            [
                "    // Act",
                "    const result = sut.Do(",
                "        arg,",
                "    );",
                "    // Assert",
                "    assert.equal(result, 1);",
            ].join("\n"),
        ),
    };

    // Act
    const findings = reviewTestSources([source], { review: true });

    // Assert
    assert.deepEqual(structureRulesOf(findings), []);
});

test("ignores statements nested in a lambda or loop body", () => {
    // Arrange
    const bodies = [
        [
            "    // Act & Assert",
            "    expect(() => {",
            "        a();",
            "        b();",
            "    }).not.toThrow();",
        ],
        [
            "    // Act",
            "    for (;;) {",
            "        a();",
            "        b();",
            "    }",
            "    // Assert",
            "    assert.ok(done);",
        ],
    ].map((lines) => declaredBody(lines.join("\n")));
    const sources = bodies.map((content) => ({
        path: "a.test.ts",
        content,
    }));

    // Act
    const found = sources.map((source) =>
        structureRulesOf(reviewTestSources([source], { review: true })),
    );

    // Assert
    assert.deepEqual(
        found,
        bodies.map(() => []),
    );
});

test("stays silent for semicolonless bodies and assert-only regions", () => {
    // Arrange
    const bodies = [
        declaredBody(
            [
                "    # Act & Assert",
                "    result = sut.do()",
                "    assert result == 1",
            ].join("\n"),
        ),
        declaredBody(
            [
                "    // Act",
                "    sut.Do();",
                "    // Assert",
                "    assert.equal(a, 1);",
                "    assert.equal(b, 2);",
            ].join("\n"),
        ),
    ];
    const sources = bodies.map((content) => ({
        path: "a.test.ts",
        content,
    }));

    // Act
    const found = sources.map((source) =>
        reviewTestSources([source], { review: true }).map(
            (finding) => finding.rule,
        ),
    );

    // Assert
    assert.deepEqual(
        found.map((rules) =>
            rules.filter((rule) => rule === "multi-statement-act"),
        ),
        bodies.map(() => []),
    );
});

test("skips a single-expression arrow body entirely", () => {
    // Arrange
    const source = {
        path: "a.test.ts",
        content:
            'import { test } from "node:test";\ntest("case", () => expect(add(1, 2)).toBe(3));',
    };

    // Act
    const findings = reviewTestSources([source], { review: true });

    // Assert
    assert.deepEqual(structureRulesOf(findings), []);
});

/** The findings one rule reports for a single declaration body. */
function findingsOf(
    content: string,
    rule: string,
): ReturnType<typeof reviewTestSources> {
    return reviewTestSources([{ path: "a.test.ts", content }], {
        review: true,
    }).filter((finding) => finding.rule === rule);
}

test("reports an assertion inside a conditional block", () => {
    // Arrange
    const content = declaredBody(
        ["    if (result > 0) {", "        assert.ok(result);", "    }"].join(
            "\n",
        ),
    );

    // Act
    const [finding] = findingsOf(content, "conditional-assertion");

    // Assert
    assert.equal(finding?.line, 3);
    assert.match(finding?.message ?? "", /if \(result > 0\)/u);
    assert.match(finding?.message ?? "", /may never run/u);
});

test("stays silent when a conditional block holds no assertion", () => {
    // Arrange
    const content = declaredBody(
        ["    if (result > 0) {", "        count++;", "    }"].join("\n"),
    );

    // Act
    const findings = findingsOf(content, "conditional-assertion");

    // Assert
    assert.deepEqual(findings, []);
});

test("reports an assertion inside a loop block", () => {
    // Arrange
    const content = declaredBody(
        [
            "    foreach (var item in items) {",
            "        Assert.Equal(1, item.Count);",
            "    }",
        ].join("\n"),
    );

    // Act
    const [finding] = findingsOf(content, "assertion-in-loop");

    // Assert
    assert.match(finding?.message ?? "", /foreach \(var item in items\)/u);
    assert.match(finding?.message ?? "", /only the first failure/u);
});

test("reports an assertion inside a forEach callback", () => {
    // Arrange
    const content = declaredBody(
        [
            "    items.forEach((item) => {",
            "        assert.ok(item);",
            "    });",
        ].join("\n"),
    );

    // Act
    const [finding] = findingsOf(content, "assertion-in-loop");

    // Assert
    assert.match(finding?.message ?? "", /items\.forEach\(/u);
});

test("stays silent when a loop holds no assertion", () => {
    // Arrange
    const content = declaredBody(
        [
            "    foreach (var item in items) {",
            "        total += item.Count;",
            "    }",
        ].join("\n"),
    );

    // Act
    const findings = findingsOf(content, "assertion-in-loop");

    // Assert
    assert.deepEqual(findings, []);
});

test("reports every braceless conditional assertion shape", () => {
    // Arrange
    const bodies = [
        "    if (isReady) Assert.True(ok);",
        "    if (isReady)\n        Assert.True(ok);",
        "    if ready: assert result == 1",
    ].map((body) => declaredBody(body));

    // Act
    const found = bodies.map((content) =>
        findingsOf(content, "conditional-assertion").map(
            (finding) => finding.rule,
        ),
    );

    // Assert
    assert.deepEqual(
        found,
        bodies.map(() => ["conditional-assertion"]),
    );
});

test("stays silent when a braceless conditional holds no assertion", () => {
    // Arrange
    const content = declaredBody("    if (isReady) cleanup();");

    // Act
    const findings = findingsOf(content, "conditional-assertion");

    // Assert
    assert.deepEqual(findings, []);
});

test("reports both branches asserting", () => {
    // Arrange
    const content = declaredBody(
        [
            "    if (isPremium) {",
            "        Assert.Equal(Tier.Premium, result);",
            "    } else {",
            "        Assert.Equal(Tier.Standard, result);",
            "    }",
        ].join("\n"),
    );

    // Act
    const [finding] = findingsOf(content, "else-branch-assertion");

    // Assert
    assert.equal(finding?.line, 5);
    assert.match(finding?.message ?? "", /both branches assert/u);
    assert.match(finding?.message ?? "", /parameterised or split/u);
});

test("reports an asserting else under a non-asserting branch", () => {
    // Arrange
    const content = declaredBody(
        [
            "    if (verbose) {",
            "        Log(result);",
            "    } else {",
            "        Assert.Equal(1, result);",
            "    }",
        ].join("\n"),
    );

    // Act
    const [finding] = findingsOf(content, "else-branch-assertion");

    // Assert
    assert.match(finding?.message ?? "", /else branch asserts/u);
});

test("stays silent when the else branch holds no assertion", () => {
    // Arrange
    const content = declaredBody(
        [
            "    if (ready) {",
            "        Assert.True(ok);",
            "    } else {",
            "        cleanup();",
            "    }",
        ].join("\n"),
    );

    // Act
    const findings = findingsOf(content, "else-branch-assertion");

    // Assert
    assert.deepEqual(findings, []);
});

test("reports every braceless else assertion shape", () => {
    // Arrange
    const bodies = [
        ["    if (ok) Do();", "    else Assert.True(b);"],
        ["    if (ok) Assert.True(a);", "    else Assert.True(b);"],
    ].map((lines) => declaredBody(lines.join("\n")));

    // Act
    const found = bodies.map((content) =>
        findingsOf(content, "else-branch-assertion").map(
            (finding) => finding.rule,
        ),
    );

    // Assert
    assert.deepEqual(
        found,
        bodies.map(() => ["else-branch-assertion"]),
    );
});

test("reports the final else of an else-if chain once", () => {
    // Arrange
    const content = declaredBody(
        [
            "    if (a) {",
            "        Assert.Equal(1, x);",
            "    } else if (b) {",
            "        Assert.Equal(2, x);",
            "    } else {",
            "        Assert.Equal(3, x);",
            "    }",
        ].join("\n"),
    );

    // Act
    const found = findingsOf(content, "else-branch-assertion");

    // Assert
    assert.deepEqual(
        found.map((finding) => finding.rule),
        ["else-branch-assertion"],
    );
});

test("reports two conditions joined in one boolean assertion", () => {
    // Arrange
    const content = declaredBody("    Assert.True(first == 1 && second == 2);");

    // Act
    const [finding] = findingsOf(content, "compound-assertion");

    // Assert
    assert.match(finding?.message ?? "", /first == 1/u);
    assert.match(finding?.message ?? "", /which condition broke/u);
});

test("reports every boolean assertion family", () => {
    // Arrange
    const bodies = [
        "Assert.That(first == 1 && second == 2, Is.True);",
        "Assert.False(ready || queued);",
        "Assert.IsTrue(a && b);",
        "Assert.IsFalse(a || b);",
        "assert(a && b);",
        "assert.ok(a || b);",
        "assertTrue(a && b);",
        "assertFalse(a || b);",
    ].map((body) => declaredBody(`    ${body}`));

    // Act
    const found = bodies.map((content) =>
        findingsOf(content, "compound-assertion").map(
            (finding) => finding.rule,
        ),
    );

    // Assert
    assert.deepEqual(
        found,
        bodies.map(() => ["compound-assertion"]),
    );
});

test("stays silent for a single boolean", () => {
    // Arrange
    const content = declaredBody("    Assert.True(ready);");

    // Act
    const findings = findingsOf(content, "compound-assertion");

    // Assert
    assert.deepEqual(findings, []);
});

test("stays silent for a property runner and a receiver-qualified assert", () => {
    // Arrange
    const bodies = [
        [
            "    fc.assert(",
            "        fc.property(fc.boolean(), fc.boolean(), (a, b) => {",
            "            return (a && b) === (a && b);",
            "        }),",
            "    );",
        ],
        ["    suite.assert(a && b);"],
        ["    t.assert(a && b);"],
    ].map((lines) => declaredBody(lines.join("\n")));

    // Act
    const found = bodies.map((content) =>
        findingsOf(content, "compound-assertion").map(
            (finding) => finding.rule,
        ),
    );

    // Assert
    assert.deepEqual(
        found,
        bodies.map(() => []),
    );
});

/** One node:test declaration with a note on the line above it. */
function notedTest(note: string, body: string): string {
    return `import { test } from "node:test";\n${note}\ntest("waits", () => {\n${body}\n});`;
}

/** A labelled body whose act is the given statement. */
function labelledBody(act: string): string {
    return [
        "    // Arrange",
        "    const started = 1;",
        "    // Act",
        `    ${act}`,
        "    // Assert",
        "    assert.ok(started);",
    ].join("\n");
}

test("a why-note suppresses its review lead and is not itself a finding", () => {
    // Arrange
    const content = notedTest(
        "// Why use sleep here: the delay proves the polling loop gives up",
        labelledBody("await sleep(5);"),
    );

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }], {
        review: true,
    });

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        [],
    );
});

test("verify reports the lead and no note, whatever the note says", () => {
    // Arrange
    const content = notedTest(
        "// Why use focused-test here: the focused run is intentional",
        "    // Act & Assert\n    assert.ok(true);",
    ).replace('test("waits"', 'test.only("waits"');

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["focused-test"],
    );
});

test("an always-on attempt is a suppression-note fault in review mode", () => {
    // Arrange
    const content = notedTest(
        "// Why use focused-test here: the focused run is intentional",
        "    // Act & Assert\n    assert.ok(true);",
    ).replace('test("waits"', 'test.only("waits"');

    // Act
    const faults = findingsOf(content, "suppression-note").filter((finding) =>
        finding.message.includes("always-on"),
    );

    // Assert
    assert.deepEqual(
        faults.map((finding) => finding.line),
        [2],
    );
});

test("a misspelt or wrong-case id suppresses nothing and reports", () => {
    // Arrange
    const notes = [
        "// Why use sleep-here: the delay proves the polling loop gives up",
        "// Why use Sleep here: the delay proves the polling loop gives up",
    ];
    const contents = notes.map((note) =>
        notedTest(note, labelledBody("await sleep(5);")),
    );

    // Act
    const found = contents.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }], {
            review: true,
        }).map((finding) => finding.rule),
    );

    // Assert
    assert.deepEqual(
        found,
        notes.map(() => ["suppression-note", "sleep"]),
    );
});

test("a vacuous reason reports and suppresses nothing", () => {
    // Arrange
    const content = notedTest(
        "// Why use sleep here: intentional",
        labelledBody("await sleep(5);"),
    );

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }], {
        review: true,
    });

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["suppression-note", "sleep"],
    );
});

test("notes naming an intent lead and the alias are accepted and inert", () => {
    // Arrange
    const notes = [
        "// Why use computed-title here: the title names the generated case",
        "// Why not use property here: rows are fixed boundary cases, not a law",
    ];
    const contents = notes.map((note) =>
        notedTest(note, labelledBody("assert.ok(started);")),
    );

    // Act
    const found = contents.map((content) =>
        reviewTestSources([{ path: "a.test.ts", content }], {
            review: true,
        }).map((finding) => finding.rule),
    );

    // Assert
    assert.deepEqual(
        found,
        notes.map(() => []),
    );
});

test("a note separated by a blank line suppresses nothing", () => {
    // Arrange
    const content = [
        'import { test } from "node:test";',
        "// Why use sleep here: the delay proves the polling loop gives up",
        "",
        'test("waits", () => {',
        labelledBody("await sleep(5);"),
        "});",
    ].join("\n");

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }], {
        review: true,
    });

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["sleep"],
    );
});

test("a note above one declaration does not suppress another", () => {
    // Arrange
    const content = [
        'import { test } from "node:test";',
        "// Why use sleep here: the delay proves the polling loop gives up",
        'test("clean", () => {',
        labelledBody("assert.ok(started);"),
        "});",
        'test("waits", () => {',
        labelledBody("await sleep(5);"),
        "});",
    ].join("\n");

    // Act
    const findings = reviewTestSources([{ path: "a.test.ts", content }], {
        review: true,
    });

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["sleep"],
    );
});
