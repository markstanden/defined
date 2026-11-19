// Tests for config/purity-rules.mjs: AST classification helpers.
// Run: node --test runtime/lib/purity-rules.test.mts
//
// The binding-aware visitors need a real parser, so their red/green semantics
// are exercised by the baked-rule fixture (runtime/purity-fixture.test.mts);
// these tests pin the pure node-shape helpers the rules depend on.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    isBuiltinSpecifier,
    isTypeOnlyExportAll,
    isTypeOnlyExportNamed,
    isTypeOnlyImport,
    isUndefinedIdentifier,
    isVoidExpression,
    memberPath,
    rootIdentifier,
    staticMemberKey,
} from "../config/purity-rules.mjs";

function identifier(name: string): Record<string, unknown> {
    return { type: "Identifier", name };
}

function literal(value: unknown): Record<string, unknown> {
    return { type: "Literal", value };
}

function member(
    object: Record<string, unknown>,
    property: Record<string, unknown>,
    computed = false,
): Record<string, unknown> {
    return { type: "MemberExpression", object, property, computed };
}

test("isBuiltinSpecifier covers bare names, subpaths and the node: namespace", () => {
    // Arrange
    const specifiers = [
        "fs",
        "fs/promises",
        "node:fs/promises",
        "node:path",
        "node:not-a-real-builtin",
        "./fs",
        "lodash",
    ];

    // Act
    const actual = specifiers.map((specifier) => isBuiltinSpecifier(specifier));

    // Assert
    assert.deepEqual(actual, [true, true, true, true, true, false, false]);
});

test("isTypeOnlyImport accepts erased declarations and rejects mixed or bare imports", () => {
    // Arrange
    const declarations = [
        { importKind: "type", specifiers: [{ importKind: "value" }] },
        {
            importKind: "value",
            specifiers: [{ importKind: "type" }, { importKind: "type" }],
        },
        {
            importKind: "value",
            specifiers: [{ importKind: "type" }, { importKind: "value" }],
        },
        { importKind: "value", specifiers: [] },
    ];

    // Act
    const actual = declarations.map((node) => isTypeOnlyImport(node as never));

    // Assert
    assert.deepEqual(actual, [true, true, false, false]);
});

test("isTypeOnlyExportNamed accepts erased exports and rejects empty or mixed export-from", () => {
    // Arrange
    const declarations = [
        { exportKind: "type", specifiers: [] },
        { exportKind: "value", specifiers: [{ exportKind: "type" }] },
        {
            exportKind: "value",
            specifiers: [{ exportKind: "type" }, { exportKind: "value" }],
        },
        { exportKind: "value", specifiers: [] },
    ];

    // Act
    const actual = declarations.map((node) =>
        isTypeOnlyExportNamed(node as never),
    );

    // Assert
    assert.deepEqual(actual, [true, true, false, false]);
});

test("isTypeOnlyExportAll reads only the export kind", () => {
    // Act
    const actual = [
        isTypeOnlyExportAll({ exportKind: "type" } as never),
        isTypeOnlyExportAll({ exportKind: "value" } as never),
    ];

    // Assert
    assert.deepEqual(actual, [true, false]);
});

test("staticMemberKey reads a dotted name or a literal computed key only", () => {
    // Act
    const actual = [
        staticMemberKey(member(identifier("a"), identifier("b"))),
        staticMemberKey(member(identifier("a"), literal("b"), true)),
        staticMemberKey(member(identifier("a"), identifier("key"), true)),
    ];

    // Assert
    assert.deepEqual(actual, ["b", "b", null]);
});

test("memberPath resolves nested static keys and gives up on a dynamic link", () => {
    // Arrange
    const nested = member(
        member(identifier("globalThis"), identifier("Math")),
        identifier("random"),
    );
    const dynamic = member(identifier("globalThis"), identifier("name"), true);

    // Act
    const actual = [memberPath(nested), memberPath(dynamic)];

    // Assert
    assert.deepEqual(actual, [
        { base: identifier("globalThis"), keys: ["Math", "random"] },
        null,
    ]);
});

test("rootIdentifier walks a member chain through TypeScript wrappers", () => {
    // Arrange
    const wrapped = {
        type: "TSNonNullExpression",
        expression: member(identifier("state"), identifier("count")),
    };

    // Act
    const actual = [
        rootIdentifier(wrapped as never),
        rootIdentifier(literal(1) as never),
    ];

    // Assert
    assert.deepEqual(actual, [identifier("state"), null]);
});

test("isVoidExpression sees through TS wrappers and rejects other expressions", () => {
    // Arrange
    const voidCall = {
        type: "TSAsExpression",
        expression: {
            type: "UnaryExpression",
            operator: "void",
            argument: { type: "CallExpression" },
        },
    };

    // Act
    const actual = [
        isVoidExpression(voidCall as never),
        isVoidExpression({
            type: "UnaryExpression",
            operator: "typeof",
        } as never),
        isVoidExpression(identifier("undefined") as never),
    ];

    // Assert
    assert.deepEqual(actual, [true, false, false]);
});

test("isUndefinedIdentifier sees through TS wrappers", () => {
    // Arrange
    const wrapped = {
        type: "TSAsExpression",
        expression: identifier("undefined"),
    };

    // Act
    const actual = [
        isUndefinedIdentifier(wrapped as never),
        isUndefinedIdentifier(identifier("null") as never),
    ];

    // Assert
    assert.deepEqual(actual, [true, false]);
});
