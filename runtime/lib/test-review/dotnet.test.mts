// Tests for the C# branch of lib/test-review/declarations.mts.
// Run: node --test runtime/lib/test-review/dotnet.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { scanTestDeclarations } from "./declarations.mts";

/** Read the declarations of one C# source. */
function scan(content: string) {
    return scanTestDeclarations({ path: "MathTests.cs", content });
}

test("reads an xUnit fact with its name, line and body", () => {
    // Arrange
    const content = [
        "using Xunit;",
        "",
        "public class MathTests",
        "{",
        "    [Fact]",
        "    public void AddsTwoNumbers()",
        "    {",
        "        Assert.Equal(3, Add(1, 2));",
        "    }",
        "}",
    ].join("\n");

    // Act
    const [declaration] = scan(content);

    // Assert
    assert.deepEqual(
        declaration === undefined
            ? null
            : {
                  name: declaration.name,
                  framework: declaration.framework,
                  line: declaration.line,
                  bodyLine: declaration.bodyLine,
                  skipped: declaration.skipped,
              },
        {
            name: "AddsTwoNumbers",
            framework: "xunit",
            line: 6,
            bodyLine: 7,
            skipped: false,
        },
    );
    assert.match(declaration?.maskedBody ?? "", /Assert\.Equal/u);
});

test("reads the framework from the attribute", () => {
    // Arrange
    const attributes = [
        { attribute: "[TestMethod]", framework: "mstest" },
        { attribute: "[Test]", framework: "nunit" },
        { attribute: "[TestCase(1, 2)]", framework: "nunit" },
    ];

    // Act
    const found = attributes.map(({ attribute }) =>
        scan(`${attribute}\npublic void Adds()\n{\n    Assert.Equal(1, 1);\n}`),
    );

    // Assert
    assert.deepEqual(
        found.map(([declaration]) => declaration?.framework),
        attributes.map((row) => row.framework),
    );
});

test("reads a theory with and without a data source", () => {
    // Arrange
    const contents = [
        "    [Theory]\n    [InlineData(1, 2)]\n    public void Adds(int a, int b)\n    {\n        Assert.Equal(a + b, Add(a, b));\n    }",
        "    [Theory]\n    public void Adds(int a, int b)\n    {\n        Assert.Equal(a + b, Add(a, b));\n    }",
    ].map((method) => `public class MathTests\n{\n${method}\n}`);

    // Act
    const found = contents.map((content) => scan(content));

    // Assert
    assert.deepEqual(
        found.map(([declaration]) => ({
            framework: declaration?.framework,
            dataSourceMissing: declaration?.dataSourceMissing,
        })),
        [
            { framework: "xunit", dataSourceMissing: false },
            { framework: "xunit", dataSourceMissing: true },
        ],
    );
});

test("reads a skip with its annotation reason", () => {
    // Arrange
    const content =
        '[Fact(Skip = "flaky until #12")]\n' +
        "public void Adds()\n{\n    Assert.Equal(1, 1);\n}";

    // Act
    const [declaration] = scan(content);

    // Assert
    assert.equal(declaration?.skipped, true);
    assert.equal(declaration?.skipReason, "flaky until #12");
});

test("reads an ignore marker without a reason", () => {
    // Arrange
    const content =
        "[Test]\n[Ignore]\npublic void Adds()\n{\n    Assert.Equal(1, 1);\n}";

    // Act
    const [declaration] = scan(content);

    // Assert
    assert.equal(declaration?.skipped, true);
    assert.equal(declaration?.skipReason, undefined);
});

test("leaves a method with no test attribute out", () => {
    // Arrange
    const content =
        "public class MathTests\n{\n" +
        "    private int Add(int a, int b)\n    {\n        return a + b;\n    }\n}";

    // Act
    const declarations = scan(content);

    // Assert
    assert.deepEqual(declarations, []);
});

test("does not read a method declaration inside a block comment", () => {
    // Arrange
    const content =
        "public class MathTests\n{\n" +
        "    /*\n    [Fact]\n    public void Fake()\n    {\n    }\n    */\n" +
        "    [Fact]\n    public void Real()\n    {\n        Assert.Equal(1, 1);\n    }\n}";

    // Act
    const declarations = scan(content);

    // Assert
    assert.deepEqual(
        declarations.map((declaration) => declaration.name),
        ["Real"],
    );
});

test("reads a method whose attributes span several lines", () => {
    // Arrange
    const content =
        "public class MathTests\n{\n" +
        '    [Fact]\n    [Trait("area", "maths")]\n' +
        "    public void Adds()\n    {\n        Assert.Equal(1, 1);\n    }\n}";

    // Act
    const [declaration] = scan(content);

    // Assert
    assert.equal(declaration?.name, "Adds");
    assert.equal(declaration?.skipped, false);
});

test("leaves an expression-bodied method without a body", () => {
    // Arrange
    const content =
        "public class MathTests\n{\n" +
        "    [Fact]\n    public void Adds() => Assert.Equal(1, 1);\n" +
        "    [Fact]\n    public void Subtracts()\n    {\n        Assert.Equal(1, 1);\n    }\n}";

    // Act
    const declarations = scan(content);

    // Assert
    assert.equal(declarations.length, 2);
    assert.equal(declarations[0]?.body, null);
    assert.match(declarations[1]?.body ?? "", /Assert\.Equal/u);
});

test("does not read a commented-out attribute", () => {
    // Arrange
    const content =
        "public class MathTests\n{\n" +
        "    // [Fact]\n    public void Helper()\n    {\n    }\n}";

    // Act
    const declarations = scan(content);

    // Assert
    assert.deepEqual(declarations, []);
});

test("does not treat a trait value as a skip", () => {
    // Arrange
    const content =
        "public class MathTests\n{\n" +
        '    [Fact]\n    [Trait("category", "Ignore")]\n' +
        "    public void Adds()\n    {\n        Assert.Equal(1, value);\n    }\n}";

    // Act
    const [declaration] = scan(content);

    // Assert
    assert.equal(declaration?.skipped, false);
});

test("reads an inline ignore reason", () => {
    // Arrange
    const content =
        '[Test]\n[Ignore("flaky until CI grid fixed")]\n' +
        "public void Adds()\n{\n    Assert.Equal(1, value);\n}";

    // Act
    const [declaration] = scan(content);

    // Assert
    assert.equal(declaration?.skipped, true);
    assert.equal(declaration?.skipReason, "flaky until CI grid fixed");
});

test("reads an FsCheck property as an xunit declaration", () => {
    // Arrange
    const content = [
        "using FsCheck.Xunit;",
        "",
        "public sealed class CustomerXmlPropertyTests",
        "{",
        "    [Property(Arbitrary = [typeof(CustomerArbitraries)])]",
        "    public void RenderThenParse_ForAnyValidCustomer_RestoresOriginal(Customer original)",
        "    {",
        "        // Assert",
        "        original.ShouldNotBeNull();",
        "    }",
        "}",
    ].join("\n");

    // Act
    const [declaration] = scan(content);

    // Assert
    assert.deepEqual(
        declaration === undefined
            ? null
            : {
                  name: declaration.name,
                  framework: declaration.framework,
                  line: declaration.line,
                  bodyLine: declaration.bodyLine,
                  property: declaration.property,
                  returnType: declaration.returnType,
              },
        {
            name: "RenderThenParse_ForAnyValidCustomer_RestoresOriginal",
            framework: "xunit",
            line: 6,
            bodyLine: 7,
            property: true,
            returnType: "void",
        },
    );
    assert.match(declaration?.maskedBody ?? "", /ShouldNotBeNull/u);
});

test("records the enclosing class and its attribute block", () => {
    // Arrange
    const content = [
        "[Properties(Arbitrary = [typeof(CustomerArbitraries)])]",
        "public sealed class CustomerXmlPropertyTests",
        "{",
        "    [Property]",
        "    public void Law(Customer customer)",
        "    {",
        "        customer.ShouldNotBeNull();",
        "    }",
        "}",
    ].join("\n");

    // Act
    const [declaration] = scan(content);

    // Assert
    assert.deepEqual(declaration?.container, {
        name: "CustomerXmlPropertyTests",
        attributes: "[Properties(Arbitrary = [typeof(CustomerArbitraries)])]",
    });
});

test("reads the innermost class as the container of a nested property", () => {
    // Arrange
    const content = [
        "public sealed class Outer",
        "{",
        "    public sealed class InnerPropertyTests",
        "    {",
        "        [Property]",
        "        public void Law(int value)",
        "        {",
        "            value.ShouldBe(value);",
        "        }",
        "    }",
        "}",
    ].join("\n");

    // Act
    const [declaration] = scan(content);

    // Assert
    assert.equal(declaration?.container?.name, "InnerPropertyTests");
});

test("does not read NUnit property metadata as an FsCheck property", () => {
    // Arrange
    const contents = [
        [
            "[Test]",
            '[Property("Category", "Slow")]',
            "public void Adds()",
            "{",
            "    Assert.Equal(1, 1);",
            "}",
        ].join("\n"),
        [
            '[Property("Category", "Slow")]',
            "public void Helper()",
            "{",
            "    Assert.Equal(1, 1);",
            "}",
        ].join("\n"),
    ];

    // Act
    const found = contents.map((content) => scan(content));

    // Assert
    assert.deepEqual(
        found.map(([declaration]) => ({
            framework: declaration?.framework,
            property: declaration?.property,
        })),
        [
            { framework: "nunit", property: false },
            { framework: undefined, property: undefined },
        ],
    );
});

test("leaves a class-level Properties attribute out of the declarations", () => {
    // Arrange
    const content = [
        "[Properties(Arbitrary = [typeof(CustomerArbitraries)])]",
        "public sealed class CustomerXmlPropertyTests",
        "{",
        "    public void Helper()",
        "    {",
        "    }",
        "}",
    ].join("\n");

    // Act
    const declarations = scan(content);

    // Assert
    assert.deepEqual(declarations, []);
});

test("leaves an expression-bodied property without a body", () => {
    // Arrange
    const content = [
        "public sealed class MathPropertyTests",
        "{",
        "    [Property]",
        "    public bool Law(int value) => value == value;",
        "}",
    ].join("\n");

    // Act
    const [declaration] = scan(content);

    // Assert
    assert.equal(declaration?.name, "Law");
    assert.equal(declaration?.body, null);
});
