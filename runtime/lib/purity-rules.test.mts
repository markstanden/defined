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
    // Act & Assert
    assert.equal(isBuiltinSpecifier("fs"), true);
    assert.equal(isBuiltinSpecifier("fs/promises"), true);
    assert.equal(isBuiltinSpecifier("node:fs/promises"), true);
    assert.equal(isBuiltinSpecifier("node:path"), true);
    assert.equal(isBuiltinSpecifier("node:not-a-real-builtin"), true);
    assert.equal(isBuiltinSpecifier("./fs"), false);
    assert.equal(isBuiltinSpecifier("lodash"), false);
});

test("isTypeOnlyImport accepts erased declarations and rejects mixed or bare imports", () => {
    // Arrange
    const typeDeclaration = {
        importKind: "type",
        specifiers: [{ importKind: "value" }],
    };
    const allTypeSpecifiers = {
        importKind: "value",
        specifiers: [{ importKind: "type" }, { importKind: "type" }],
    };
    const mixed = {
        importKind: "value",
        specifiers: [{ importKind: "type" }, { importKind: "value" }],
    };
    const sideEffectOnly = { importKind: "value", specifiers: [] };

    // Act & Assert
    assert.equal(isTypeOnlyImport(typeDeclaration as never), true);
    assert.equal(isTypeOnlyImport(allTypeSpecifiers as never), true);
    assert.equal(isTypeOnlyImport(mixed as never), false);
    assert.equal(isTypeOnlyImport(sideEffectOnly as never), false);
});

test("isTypeOnlyExportNamed accepts erased exports and rejects empty or mixed export-from", () => {
    // Arrange
    const typeExport = { exportKind: "type", specifiers: [] };
    const allTypeSpecifiers = {
        exportKind: "value",
        specifiers: [{ exportKind: "type" }],
    };
    const mixed = {
        exportKind: "value",
        specifiers: [{ exportKind: "type" }, { exportKind: "value" }],
    };
    const emptyExportFrom = { exportKind: "value", specifiers: [] };

    // Act & Assert
    assert.equal(isTypeOnlyExportNamed(typeExport as never), true);
    assert.equal(isTypeOnlyExportNamed(allTypeSpecifiers as never), true);
    assert.equal(isTypeOnlyExportNamed(mixed as never), false);
    assert.equal(isTypeOnlyExportNamed(emptyExportFrom as never), false);
});

test("isTypeOnlyExportAll reads only the export kind", () => {
    assert.equal(isTypeOnlyExportAll({ exportKind: "type" } as never), true);
    assert.equal(isTypeOnlyExportAll({ exportKind: "value" } as never), false);
});

test("staticMemberKey reads a dotted name or a literal computed key only", () => {
    // Act & Assert
    assert.equal(
        staticMemberKey(member(identifier("a"), identifier("b"))),
        "b",
    );
    assert.equal(
        staticMemberKey(member(identifier("a"), literal("b"), true)),
        "b",
    );
    assert.equal(
        staticMemberKey(member(identifier("a"), identifier("key"), true)),
        null,
    );
});

test("memberPath resolves nested static keys and gives up on a dynamic link", () => {
    // Arrange
    const path = memberPath(
        member(
            member(identifier("globalThis"), identifier("Math")),
            identifier("random"),
        ),
    );
    const dynamic = memberPath(
        member(identifier("globalThis"), identifier("name"), true),
    );

    // Act & Assert
    assert.deepEqual(path, {
        base: identifier("globalThis"),
        keys: ["Math", "random"],
    });
    assert.equal(dynamic, null);
});

test("rootIdentifier walks a member chain through TypeScript wrappers", () => {
    // Arrange
    const wrapped = {
        type: "TSNonNullExpression",
        expression: member(identifier("state"), identifier("count")),
    };

    // Act & Assert
    assert.equal(rootIdentifier(wrapped as never)?.name, "state");
    assert.equal(rootIdentifier(literal(1) as never), null);
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

    // Act & Assert
    assert.equal(isVoidExpression(voidCall as never), true);
    assert.equal(
        isVoidExpression({
            type: "UnaryExpression",
            operator: "typeof",
        } as never),
        false,
    );
    assert.equal(isVoidExpression(identifier("undefined") as never), false);
});

test("isUndefinedIdentifier sees through TS wrappers", () => {
    // Arrange
    const wrapped = {
        type: "TSAsExpression",
        expression: identifier("undefined"),
    };

    // Act & Assert
    assert.equal(isUndefinedIdentifier(wrapped as never), true);
    assert.equal(isUndefinedIdentifier(identifier("null") as never), false);
});
