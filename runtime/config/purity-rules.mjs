// purity-rules.mjs — the baked rules behind the opt-in purity step.
//
// Plain ESM, loaded by runtime/config/purity.config.mjs inside the image. It
// imports only Node built-ins and receives everything else from ESLint's
// context, so the step never imports a consumer module or executes source.
//
// Four rules share one policy object (repo-relative paths resolved by
// lib/purity.mts):
//   defined/pure-module  — a declared pure module may not take a runtime
//                          dependency (built-in import/re-export, dynamic
//                          import, require, import-equals), read the
//                          enumerated ambient effects, or mutate a parameter.
//   defined/cqs-command  — a declared command may not return a value.
//   defined/cqs-query    — a declared query may not write a parameter or a
//                          captured/ambient binding.
//   defined/cqs-targets  — a declared symbol must resolve to a supported,
//                          implemented top-level declaration.
//
// AST-only: no type information, no data flow, no proof of purity. The limits
// are documented in standards/node-purity.md and restated in each message's
// remedy.

import { isBuiltin } from "node:module";
import { relative } from "node:path";

const AMBIENT_GLOBALS = new Set([
    "process",
    "console",
    "fetch",
    "setTimeout",
    "setInterval",
    "setImmediate",
]);

const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"]);

const POLICY_OPTIONS = [
    {
        type: "object",
        properties: { policy: { type: "object" } },
        required: ["policy"],
        additionalProperties: false,
    },
];

/** Resolve a node through the TypeScript wrapper expressions that keep a value. */
function unwrap(node) {
    let current = node;
    for (;;) {
        if (
            current !== undefined &&
            current !== null &&
            (current.type === "TSAsExpression" ||
                current.type === "TSTypeAssertion" ||
                current.type === "TSNonNullExpression" ||
                current.type === "TSSatisfiesExpression" ||
                current.type === "TSInstantiationExpression")
        ) {
            current = current.expression;
            continue;
        }
        return current;
    }
}

/** True when a declaration is erased by TypeScript: `import type` or all-type specifiers. */
export function isTypeOnlyImport(node) {
    if (node.importKind === "type") {
        return true;
    }
    return (
        node.specifiers.length > 0 &&
        node.specifiers.every((specifier) => specifier.importKind === "type")
    );
}

/** True when a named export-from is erased: `export type` or all-type specifiers. */
export function isTypeOnlyExportNamed(node) {
    if (node.exportKind === "type") {
        return true;
    }
    return (
        node.specifiers.length > 0 &&
        node.specifiers.every((specifier) => specifier.exportKind === "type")
    );
}

/** True when `export *`/`export * as ns` is an erased type-only export. */
export function isTypeOnlyExportAll(node) {
    return node.exportKind === "type";
}

/** True when a specifier names a Node built-in, bare or under `node:`. */
export function isBuiltinSpecifier(specifier) {
    return specifier.startsWith("node:") || isBuiltin(specifier);
}

/** The literal key of a member expression (`a.b` or `a["b"]`), else null. */
export function staticMemberKey(member) {
    if (!member.computed) {
        return member.property?.type === "Identifier"
            ? member.property.name
            : null;
    }
    return member.property?.type === "Literal" &&
        typeof member.property.value === "string"
        ? member.property.value
        : null;
}

/**
 * The dotted path of nested static member expressions, with the base
 * identifier: `globalThis["Math"].random` → `{ base: globalThis id,
 * keys: ["Math", "random"] }`. Null when any link is dynamic.
 */
export function memberPath(node) {
    const keys = [];
    let current = node;
    while (current?.type === "MemberExpression") {
        const key = staticMemberKey(current);
        if (key === null) {
            return null;
        }
        keys.unshift(key);
        current = current.object;
    }
    if (current?.type !== "Identifier") {
        return null;
    }
    return { base: current, keys };
}

/** The root identifier of a member chain (`a.b.c` → `a`), else null. */
export function rootIdentifier(node) {
    let current = unwrap(node);
    while (current?.type === "MemberExpression") {
        current = unwrap(current.object);
    }
    return current?.type === "Identifier" ? current : null;
}

/** True for a `void <expr>` expression, which always yields undefined. */
export function isVoidExpression(node) {
    const inner = unwrap(node);
    return inner?.type === "UnaryExpression" && inner.operator === "void";
}

/** True for a bare `undefined` reference (caller decides whether it is shadowed). */
export function isUndefinedIdentifier(node) {
    const inner = unwrap(node);
    return inner?.type === "Identifier" && inner.name === "undefined";
}

/** Index every scope reference by its identifier, for binding-aware checks. */
function referenceIndex(sourceCode) {
    const byIdentifier = new Map();
    for (const scope of sourceCode.scopeManager.scopes) {
        for (const reference of scope.references) {
            byIdentifier.set(reference.identifier, reference);
        }
    }
    return byIdentifier;
}

/**
 * True when a value reference is ambient: unresolved, or a global declared by
 * the parser's lib with no local definition. A shadowing binding resolves to a
 * non-global scope (or has a definition) and is therefore not ambient.
 */
function isAmbientReference(reference) {
    if (reference === undefined || reference.isValueReference !== true) {
        return false;
    }
    if (reference.resolved === null) {
        return true;
    }
    return (
        reference.resolved.scope?.type === "global" &&
        reference.resolved.defs.length === 0
    );
}

/** The repo-relative path of the file being linted, with forward slashes. */
function repoFile(context) {
    const filename = context.filename ?? context.getFilename();
    const cwd = context.cwd ?? process.cwd();
    return relative(cwd, filename).split("\\").join("/");
}

/** The per-file CQS entry from a policy, or null. */
function cqsEntry(policy, file) {
    return policy?.cqs?.[file] ?? null;
}

/** Policy options as the rule receives them. */
function policyOf(context) {
    return context.options[0]?.policy;
}

/** Every top-level declaration that could name a CQS target. */
function declaredItems(program) {
    const items = [];
    function addDeclaration(declaration) {
        if (declaration === null || declaration === undefined) {
            return;
        }
        if (addFunctionDeclaration(declaration, items)) {
            return;
        }
        addVariableDeclaration(declaration, items);
    }
    for (const statement of program.body) {
        if (
            statement.type === "ExportNamedDeclaration" ||
            statement.type === "ExportDefaultDeclaration"
        ) {
            addDeclaration(statement.declaration);
        } else {
            addDeclaration(statement);
        }
    }
    return items;
}

/** Record a function declaration or an overload signature. */
function addFunctionDeclaration(declaration, items) {
    if (
        declaration.type !== "FunctionDeclaration" &&
        declaration.type !== "TSDeclareFunction"
    ) {
        return false;
    }
    items.push({
        name: declaration.id?.name,
        kind: "function",
        node: declaration,
        implemented:
            declaration.type === "FunctionDeclaration" &&
            declaration.body !== null,
    });
    return true;
}

/** Record each top-level const/let/var declaration as a possible target. */
function addVariableDeclaration(declaration, items) {
    if (declaration.type !== "VariableDeclaration") {
        return;
    }
    for (const declarator of declaration.declarations) {
        if (declarator.id?.type !== "Identifier") {
            continue;
        }
        const init = unwrap(declarator.init);
        const callable =
            init?.type === "ArrowFunctionExpression" ||
            init?.type === "FunctionExpression";
        items.push({
            name: declarator.id.name,
            kind: callable ? "const-function" : "other",
            bindingKind: declaration.kind,
            node: callable ? init : declaration,
            implemented: callable,
        });
    }
}

const UNSUPPORTED_FORM =
    "v1 supports top-level function declarations and const-bound arrow/function expressions (no methods, generators, or let/var bindings)";

/**
 * Resolve one declared target name to its implementation.
 *
 * Returns `{ fn }` for a supported implementation, else `{ error, node }`.
 * A declaration without an implemented body never resolves — overload
 * signatures alone are reported, never silently checked.
 */
function resolveTarget(items, name) {
    const matches = items.filter((item) => item.name === name);
    if (matches.length === 0) {
        return {
            error:
                `"${name}" is declared in .defined.json purity but is not a top-level function declaration ` +
                "or const-bound arrow/function expression in this file",
            node: null,
        };
    }
    const other = matches.find((item) => item.kind === "other");
    if (other !== undefined) {
        return {
            error: `"${name}" is a ${other.bindingKind}-bound value that is not an arrow or function expression; ${UNSUPPORTED_FORM}`,
            node: other.node,
        };
    }
    const implementations = matches.filter((item) => item.implemented);
    if (implementations.length === 0) {
        return {
            error:
                `"${name}" has only overload signatures and no implemented body; ` +
                "a declaration without an implementation is never counted as checked",
            node: matches[0].node,
        };
    }
    if (implementations.length > 1) {
        return {
            error: `"${name}" has more than one implementation in this file; ${UNSUPPORTED_FORM}`,
            node: implementations[1].node,
        };
    }
    const target = implementations[0];
    if (target.bindingKind !== undefined && target.bindingKind !== "const") {
        return {
            error: `"${name}" is a ${target.bindingKind}-bound value; ${UNSUPPORTED_FORM}`,
            node: target.node,
        };
    }
    if (target.node.generator === true) {
        return {
            error: `"${name}" is a generator; ${UNSUPPORTED_FORM}`,
            node: target.node,
        };
    }
    return { fn: target.node, node: target.node };
}

/** True when `variable` is declared at or inside the function's own scope. */
function isDeclaredWithin(variable, fnScope) {
    let scope = variable.scope;
    while (scope !== null && scope !== undefined) {
        if (scope === fnScope) {
            return true;
        }
        scope = scope.upper;
    }
    return false;
}

/** True when the resolved binding is a function parameter. */
function isParameter(variable) {
    return variable.defs.some((def) => def.type === "Parameter");
}

/** Collect write roots from an assignment target, carrying property-ness. */
function collectWrites(pattern, propertyRooted, out) {
    const node = unwrap(pattern);
    if (node === null || node === undefined) {
        return out;
    }
    switch (node.type) {
        case "Identifier":
            out.push({ id: node, property: propertyRooted });
            return out;
        case "MemberExpression": {
            const root = rootIdentifier(node);
            if (root !== null) {
                out.push({ id: root, property: true });
            }
            return out;
        }
        case "ObjectPattern":
            return collectObjectPattern(node, propertyRooted, out);
        case "ArrayPattern":
            return collectArrayPattern(node, propertyRooted, out);
        case "AssignmentPattern":
            return collectWrites(node.left, propertyRooted, out);
        case "RestElement":
            return collectWrites(node.argument, propertyRooted, out);
        default:
            return out;
    }
}

/** Collect write roots from an object destructuring pattern. */
function collectObjectPattern(node, propertyRooted, out) {
    for (const property of node.properties) {
        if (property.type === "Property") {
            collectWrites(property.value, propertyRooted, out);
        } else if (property.type === "RestElement") {
            collectWrites(property.argument, propertyRooted, out);
        }
    }
    return out;
}

/** Collect write roots from an array destructuring pattern. */
function collectArrayPattern(node, propertyRooted, out) {
    for (const element of node.elements) {
        if (element !== null) {
            collectWrites(element, propertyRooted, out);
        }
    }
    return out;
}

/** Message for an ambient read in a pure module. */
function ambientMessage(name) {
    if (TIMERS.has(name)) {
        return `schedules work with "${name}". Scheduling is an effect — move it to the caller.`;
    }
    if (name === "console") {
        return "writes to the ambient console. Move logging to the caller and pass the result in.";
    }
    return `reads the ambient global "${name}". Pass the value in as a parameter, or move the effect to the caller.`;
}

function clockMessage(kind) {
    if (kind === "Date()") {
        return "reads the ambient clock via Date(). Take the instant as a parameter; new Date(0) and an explicit instant are fine.";
    }
    if (kind === "new Date()") {
        return "reads the ambient clock via new Date(). Take the instant as a parameter; new Date(instant) is fine.";
    }
    return "reads the ambient clock via Date.now(). Take the instant as a parameter.";
}

/** One rule that vetoes runtime edges, ambient effects and parameter writes. */
export const pureModuleRule = {
    meta: {
        type: "problem",
        docs: {
            description:
                "A declared pure module takes no runtime dependency, reads no enumerated ambient effect and mutates no parameter.",
        },
        schema: POLICY_OPTIONS,
    },
    /** Build the rule visitor for one file. */
    create(context) {
        const policy = policyOf(context);
        const file = repoFile(context);
        if (!Array.isArray(policy?.pure) || !policy.pure.includes(file)) {
            return {};
        }
        const sourceCode = context.sourceCode;
        const references = referenceIndex(sourceCode);
        const ambient = (identifier) =>
            isAmbientReference(references.get(identifier));

        function report(node, message) {
            context.report({ node, message });
        }

        function reportClockMember(node, path) {
            const dotted = path.keys.join(".");
            if (path.base.name === "Date" && dotted === "now") {
                report(node, clockMessage("Date.now()"));
                return true;
            }
            if (path.base.name === "Math" && dotted === "random") {
                report(
                    node,
                    "uses Math.random(). Take the random value as a parameter; deterministic Math helpers are fine.",
                );
                return true;
            }
            return false;
        }

        function reportGlobalThisMember(node, path) {
            const dotted = path.keys.join(".");
            if (path.keys.length === 1 && AMBIENT_GLOBALS.has(path.keys[0])) {
                report(node, ambientMessage(path.keys[0]));
                return;
            }
            if (dotted === "Date.now") {
                report(node, clockMessage("Date.now()"));
                return;
            }
            if (dotted === "Math.random") {
                report(
                    node,
                    "uses Math.random(). Take the random value as a parameter; deterministic Math helpers are fine.",
                );
            }
        }

        function checkGlobalPath(node) {
            const path = memberPath(node);
            if (path === null || !ambient(path.base)) {
                return;
            }
            if (reportClockMember(node, path)) {
                return;
            }
            if (path.base.name === "globalThis") {
                reportGlobalThisMember(node, path);
            }
        }

        function checkClockCall(node) {
            const callee = unwrap(node.callee);
            if (callee?.type === "Identifier") {
                if (callee.name === "Date" && ambient(callee)) {
                    report(node, clockMessage("Date()"));
                }
                return;
            }
            const path = memberPath(callee);
            if (
                path !== null &&
                path.base.name === "globalThis" &&
                ambient(path.base) &&
                path.keys.length === 1 &&
                path.keys[0] === "Date"
            ) {
                report(node, clockMessage("Date()"));
            }
        }

        function checkParameterWrite(pattern) {
            for (const write of collectWrites(pattern, false, [])) {
                if (!write.property) {
                    continue;
                }
                const variable = references.get(write.id)?.resolved;
                if (
                    variable !== null &&
                    variable !== undefined &&
                    isParameter(variable)
                ) {
                    report(
                        write.id,
                        `mutates parameter "${write.id.name}". Treat inputs as read-only and build a new value instead.`,
                    );
                }
            }
        }

        return {
            ["ImportDeclaration"]: (node) => {
                if (isTypeOnlyImport(node)) {
                    return;
                }
                if (!isBuiltinSpecifier(node.source.value)) {
                    return;
                }
                report(
                    node,
                    `imports "${node.source.value}". Move the Node built-in use to the caller and pass its contents or result into the calculation.`,
                );
            },
            ["ExportNamedDeclaration"]: (node) => {
                if (node.source === null || node.source === undefined) {
                    return;
                }
                if (
                    isTypeOnlyExportNamed(node) ||
                    !isBuiltinSpecifier(node.source.value)
                ) {
                    return;
                }
                report(
                    node,
                    `re-exports "${node.source.value}" at runtime. A pure module cannot pull in Node built-ins; move the dependency to the caller.`,
                );
            },
            ["ExportAllDeclaration"]: (node) => {
                if (
                    isTypeOnlyExportAll(node) ||
                    !isBuiltinSpecifier(node.source.value)
                ) {
                    return;
                }
                report(
                    node,
                    `re-exports all of "${node.source.value}" at runtime. A pure module cannot pull in Node built-ins; move the dependency to the caller.`,
                );
            },
            ["ImportExpression"]: (node) => {
                report(
                    node,
                    "uses dynamic import(). Load the dependency in the caller and pass the loaded value in; computed and literal specifiers are both rejected here.",
                );
            },
            ["TSImportEqualsDeclaration"]: (node) => {
                if (node.importKind === "type") {
                    return;
                }
                report(
                    node,
                    "uses a runtime import-equals loader. Move the dependency to the caller; use a type-only import if the reference is erased.",
                );
            },
            ["CallExpression"]: (node) => {
                checkClockCall(node);
                const callee = unwrap(node.callee);
                if (
                    callee?.type === "Identifier" &&
                    callee.name === "require" &&
                    ambient(callee)
                ) {
                    report(
                        node,
                        "uses the ambient CommonJS require() loader. Load the dependency in the caller and pass the value in.",
                    );
                }
            },
            ["NewExpression"]: (node) => {
                if (node.arguments.length !== 0) {
                    return;
                }
                const callee = unwrap(node.callee);
                if (callee?.type === "Identifier") {
                    if (callee.name === "Date" && ambient(callee)) {
                        report(node, clockMessage("new Date()"));
                    }
                    return;
                }
                const path = memberPath(callee);
                if (
                    path?.base.name === "globalThis" &&
                    ambient(path.base) &&
                    path.keys.length === 1 &&
                    path.keys[0] === "Date"
                ) {
                    report(node, clockMessage("new Date()"));
                }
            },
            ["Identifier"]: (node) => {
                if (!AMBIENT_GLOBALS.has(node.name) || !ambient(node)) {
                    return;
                }
                report(node, ambientMessage(node.name));
            },
            ["MemberExpression"]: (node) => {
                checkGlobalPath(node);
            },
            ["AssignmentExpression"]: (node) => {
                checkParameterWrite(node.left);
            },
            ["UpdateExpression"]: (node) => {
                checkParameterWrite(node.argument);
            },
            ["UnaryExpression"]: (node) => {
                if (node.operator === "delete") {
                    checkParameterWrite(node.argument);
                }
            },
            ["ForOfStatement"]: (node) => {
                if (node.left.type !== "VariableDeclaration") {
                    checkParameterWrite(node.left);
                }
            },
            ["ForInStatement"]: (node) => {
                if (node.left.type !== "VariableDeclaration") {
                    checkParameterWrite(node.left);
                }
            },
        };
    },
};

/** The query rule: no parameter property writes and no captured/global writes. */
export const cqsQueryRule = {
    meta: {
        type: "problem",
        docs: {
            description:
                "A declared query does not write parameters, captured bindings or ambient globals.",
        },
        schema: POLICY_OPTIONS,
    },
    /** Build the rule visitor for one file. */
    create(context) {
        const policy = policyOf(context);
        const file = repoFile(context);
        const entry = cqsEntry(policy, file);
        if (entry === null || (entry.queries ?? []).length === 0) {
            return {};
        }
        const sourceCode = context.sourceCode;
        const references = referenceIndex(sourceCode);
        const items = declaredItems(sourceCode.ast);
        const targets = new Map();
        for (const name of entry.queries) {
            const resolved = resolveTarget(items, name);
            if (resolved.fn !== undefined) {
                targets.set(resolved.fn, name);
            }
        }
        if (targets.size === 0) {
            return {};
        }
        const fnStack = [];

        function activeTarget() {
            for (let index = fnStack.length - 1; index >= 0; index -= 1) {
                const name = targets.get(fnStack[index]);
                if (name !== undefined) {
                    return { fn: fnStack[index], name };
                }
            }
            return null;
        }

        function checkWrite(pattern) {
            const target = activeTarget();
            if (target === null) {
                return;
            }
            const fnScope = sourceCode.getScope(target.fn);
            for (const write of collectWrites(pattern, false, [])) {
                const variable = references.get(write.id)?.resolved;
                if (variable === null || variable === undefined) {
                    context.report({
                        node: write.id,
                        message: `writes the global "${write.id.name}". A query must not change observable state; move the write into a command.`,
                    });
                    continue;
                }
                if (isParameter(variable) && variable.scope === fnScope) {
                    if (write.property) {
                        context.report({
                            node: write.id,
                            message: `mutates parameter "${write.id.name}". A query must not change its inputs; copy the value first, or move the mutation into a command.`,
                        });
                    }
                    continue;
                }
                if (isDeclaredWithin(variable, fnScope)) {
                    continue;
                }
                context.report({
                    node: write.id,
                    message: `writes "${write.id.name}", which is declared outside the query. A query must not change observable state; move the write into a command or copy the value locally.`,
                });
            }
        }

        function enter(node) {
            fnStack.push(node);
        }

        function exit() {
            fnStack.pop();
        }

        return {
            FunctionDeclaration: enter,
            FunctionExpression: enter,
            ArrowFunctionExpression: enter,
            "FunctionDeclaration:exit": exit,
            "FunctionExpression:exit": exit,
            "ArrowFunctionExpression:exit": exit,
            ["AssignmentExpression"]: (node) => {
                checkWrite(node.left);
            },
            ["UpdateExpression"]: (node) => {
                checkWrite(node.argument);
            },
            ["UnaryExpression"]: (node) => {
                if (node.operator === "delete") {
                    checkWrite(node.argument);
                }
            },
            ["ForOfStatement"]: (node) => {
                if (node.left.type !== "VariableDeclaration") {
                    checkWrite(node.left);
                }
            },
            ["ForInStatement"]: (node) => {
                if (node.left.type !== "VariableDeclaration") {
                    checkWrite(node.left);
                }
            },
        };
    },
};

/** The command rule: no value-bearing return in the declared implementation. */
export const cqsCommandRule = {
    meta: {
        type: "problem",
        docs: {
            description:
                "A declared command returns no value; it falls through, returns bare, or returns undefined/void.",
        },
        schema: POLICY_OPTIONS,
    },
    /** Build the rule visitor for one file. */
    create(context) {
        const policy = policyOf(context);
        const file = repoFile(context);
        const entry = cqsEntry(policy, file);
        if (entry === null || (entry.commands ?? []).length === 0) {
            return {};
        }
        const sourceCode = context.sourceCode;
        const references = referenceIndex(sourceCode);
        const items = declaredItems(sourceCode.ast);
        const targets = new Set();
        for (const name of entry.commands) {
            const resolved = resolveTarget(items, name);
            if (resolved.fn !== undefined) {
                targets.add(resolved.fn);
            }
        }
        if (targets.size === 0) {
            return {};
        }
        const fnStack = [];

        function noValue(node) {
            if (isVoidExpression(node)) {
                return true;
            }
            if (!isUndefinedIdentifier(node)) {
                return false;
            }
            return isAmbientReference(references.get(unwrap(node)));
        }

        function report(node, implicit) {
            context.report({
                node,
                message: implicit
                    ? "implicitly returns a value from an expression body. A command must not return data — use a block body and return nothing (or void); expose results through a query."
                    : "returns a value. A command must not return data — return nothing (or void); expose results through a query.",
            });
        }

        function enter(node) {
            fnStack.push(node);
            if (!targets.has(node)) {
                return;
            }
            if (
                node.type === "ArrowFunctionExpression" &&
                node.body.type !== "BlockStatement" &&
                !noValue(node.body)
            ) {
                report(node.body, true);
            }
        }

        function exit() {
            fnStack.pop();
        }

        return {
            FunctionDeclaration: enter,
            FunctionExpression: enter,
            ArrowFunctionExpression: enter,
            "FunctionDeclaration:exit": exit,
            "FunctionExpression:exit": exit,
            "ArrowFunctionExpression:exit": exit,
            ["ReturnStatement"]: (node) => {
                const fn = fnStack[fnStack.length - 1];
                if (fn === undefined || !targets.has(fn)) {
                    return;
                }
                if (node.argument === null || noValue(node.argument)) {
                    return;
                }
                report(node.argument, false);
            },
        };
    },
};

/** The target rule: stale, unimplemented and unsupported declarations report. */
export const cqsTargetsRule = {
    meta: {
        type: "problem",
        docs: {
            description:
                "Every declared command/query resolves to a supported, implemented top-level declaration.",
        },
        schema: POLICY_OPTIONS,
    },
    /** Build the rule visitor for one file. */
    create(context) {
        const policy = policyOf(context);
        const file = repoFile(context);
        const entry = cqsEntry(policy, file);
        if (entry === null) {
            return {};
        }
        const items = declaredItems(context.sourceCode.ast);
        return {
            ["Program"]: (node) => {
                for (const name of [
                    ...(entry.commands ?? []),
                    ...(entry.queries ?? []),
                ]) {
                    const resolved = resolveTarget(items, name);
                    if (resolved.error !== undefined) {
                        context.report({
                            node: resolved.node ?? node,
                            message: resolved.error,
                        });
                    }
                }
            },
        };
    },
};
