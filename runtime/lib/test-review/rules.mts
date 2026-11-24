// lib/test-review/rules.mts — the test-hygiene rule engine.
//
// Rules read masked source (lib/test-review/mask.mts) and report findings in
// the gate's diagnostic vocabulary: rule id, repo-relative file, 1-based line
// and an actionable message. A finding names the rule, never a verdict about
// the reviewer's judgement.
//
// Public surface:
//   reviewTestSources(sources) — always-on findings for the named sources
//   ALWAYS_ON_RULES — the rule ids this pass can report
//
// The focused-declaration pair is the first rule family. `focused-test` reads a
// focused modifier on a test call (`it.only`, `test.only`, `specify.only`);
// `focused-suite` reads a focused suite declaration (`describe.only`,
// `suite.only`, `fdescribe`, `fsuite`). Both are defects: the rest of the suite
// or file silently does not run.
//
// `skipped-test` reads the declaration layer: a declaration marked to skip is
// a defect unless a reason or ticket parks it. A ticket reference (`#123`,
// `PROJ-123`, a URL) in the declaration's own line, the contiguous comment
// block above it, or the C# attribute block parks the skip; a reason the
// framework records in its annotation (C# `Skip = "…"`) always does.
//
// `theory-without-data` reads the C# declaration layer: a `[Theory]` or
// `[DataTestMethod]` with no `InlineData`/`MemberData`/`ClassData`/`DataRow`/
// `DynamicData` runs zero cases and reports green. A JS `it.each` empty table
// is not read yet.
//
// `literal-tautology` reads each declaration's masked body: a comparison of a
// literal with itself, or an expression with itself, cannot fail for any input.
// `commented-out-assertion` reads the raw body lines: an assertion left in a
// comment never runs, so nothing is checked at that point. The oracle's rules
// for other stacks (PHPUnit, Python) land with those declaration layers.
//
// The tautology patterns cover the Jest/Vitest `expect` shapes and the
// xUnit/NUnit `Assert` shapes (`Assert.Equal(3, 3)`, `Assert.True(true)`); the
// first pattern to claim a position wins, so a literal compared with itself
// reports once, as a literal. A comment-led line is read from the raw body, so
// a fixture string whose own line begins with a comment marker reads as a
// comment — the scanner shares that shape.
//
// `no-assertions` counts the assertion shapes of the declaration's framework in
// the masked body. For JavaScript: the assertion verb directly
// (`expect(`/`assert(`/`should(`), the verb with an uppercase suffix
// (`assertOk(`, an assertion helper by name), and the dotted statics
// (`assert.equal(`, `should.match(`). For .NET: `Assert.*`, `StringAssert.*`,
// `CollectionAssert.*`, FluentAssertions `Should()`/`.Should.Be…`, Moq
// `Verify(`, a helper named with the verb (`AssertInvariants(`), Playwright's
// `Expect(`, and Shouldly's generic forms (`ShouldThrow<…>`). The oracle misses
// the last three and so reports five false positives across the C# corpus. A
// helper that merely delegates (`check(...)`) does not count, so a body of
// helpers reports. A skipped declaration is left to `skipped-test`: a parked
// skip may legitimately carry no assertion until its ticket lands, and
// reporting both would double the defect.
//
// `unawaited-async-assertion` reads a block body's statements: a `.rejects`
// assertion (or the C# `ThrowsAsync`/`ThrowAsync` shape, which the C# layer
// will reach) that is neither awaited nor returned never executes. An
// expression-arrow body returns implicitly, so it is exempt. The await is read
// from the same statement, so an earlier awaited call does not excuse it.
//
// Deliberate ceiling (ponytail): that read is lexical and statement-scoped. A
// `.rejects` promise stored and awaited on a later line reports, as does one
// inside a nested arrow body; the scanner shares both shapes. Upgrade to a
// parser if either ever turns up for real.
//
// `swallowed-exception` reads `catch` blocks: one that neither asserts nor
// rethrows cannot tell a wrong exception from the expected one. A flag set in
// the catch and referenced by a later assertion in the same test is the
// documented exception — a lexical read of flow, not a parser's. A promise
// `.catch(...)` callback is not a catch block and is ignored.
//
// The OpenCollection rules read request and environment files rather than test
// declarations (lib/test-review/opencollection.mts): `no-tests` is a request
// declaring neither a runtime assertion nor a tests script with code;
// `hardcoded-host` is a literal scheme and host in the request url;
// `plaintext-credential` is a literal credential inside `http.auth`, its value
// always withheld; `unlabelled-secret-var` is a credential-named environment
// variable holding a literal value and not marked `secret: true`. They are
// bounded to collection hygiene — never a repo-wide secrets sweep.
//
// Deliberate ceiling (ponytail): the marker regex reads contiguous call text,
// so `it` split from `.only` across lines reads as unfocused — the scanner's
// declaration head has the same shape. The marker also matches wherever the
// call text appears in masked code, not only at a declaration head.

import { lineAt, scanTestDeclarations } from "./declarations.mts";
import type { TestDeclaration, TestFramework } from "./declarations.mts";
import { maskTestSource } from "./mask.mts";
import {
    isEnvironmentPath,
    readCollectionRequest,
    readEnvironmentVariables,
} from "./opencollection.mts";

/** The rule ids the always-on pass can report. */
export const ALWAYS_ON_RULES = [
    "focused-test",
    "focused-suite",
    "theory-without-data",
    "skipped-test",
    "literal-tautology",
    "commented-out-assertion",
    "no-assertions",
    "unawaited-async-assertion",
    "swallowed-exception",
    "no-tests",
    "hardcoded-host",
    "plaintext-credential",
    "unlabelled-secret-var",
] as const;

/** One always-on test-hygiene rule id. */
export type TestHygieneRule = (typeof ALWAYS_ON_RULES)[number];

/** One source file the rule engine reads. */
export interface TestReviewSource {
    /** Repo-relative path reported on every finding. */
    readonly path: string;
    /** Full UTF-8 contents. */
    readonly content: string;
}

/** One always-on finding, shaped for a step diagnostic. */
export interface TestHygieneFinding {
    /** The rule that fired. */
    readonly rule: TestHygieneRule;
    /** Repo-relative path of the source. */
    readonly file: string;
    /** 1-based line of the declaration. */
    readonly line: number;
    /** What was found and why it is a defect. */
    readonly message: string;
}

/** A focused test call: every other test in the suite is skipped. */
const FOCUSED_TEST = /\b(it|test|specify)\.only\b/g;

/** A focused suite declaration: every other suite in the file is skipped. */
const FOCUSED_SUITE =
    /(?:describe|suite)\.only\s*\(|\bf(?:describe|suite)\s*\(/g;

/** Every match of one rule in one masked source, in source order. */
function matchFindings({
    source,
    masked,
    rule,
    pattern,
    message,
}: {
    source: TestReviewSource;
    masked: string;
    rule: TestHygieneRule;
    pattern: RegExp;
    message: (evidence: string) => string;
}): TestHygieneFinding[] {
    return [...masked.matchAll(pattern)].map((match) => ({
        rule,
        file: source.path,
        line: lineAt({ content: source.content, index: match.index ?? 0 }),
        message: message(match[0].trim()),
    }));
}

/** A ticket reference that parks a skip beside a declaration. */
const TICKET = /(?:#\d+\b|\b[A-Z][A-Z0-9]+-\d+\b|https?:\/\/\S+)/;

/**
 * Whether a skip is parked: its own line or the contiguous comment block
 * immediately above it carries a ticket reference.
 */
function parkedSkip({
    content,
    line,
}: {
    content: string;
    line: number;
}): boolean {
    const lines = content.split("\n");
    const context = [lines[line - 1] ?? ""];
    for (let index = line - 2; index >= 0; index--) {
        const raw = lines[index] ?? "";
        const trimmed = raw.trim();
        if (trimmed === "" || !/^(?:\/\/|\/\*|\*|\*\/|\[)/u.test(trimmed)) {
            break;
        }
        context.unshift(raw);
    }
    return TICKET.test(context.join("\n"));
}

/** Findings for skipped declarations that carry no reason or ticket. */
function skippedFindings({
    source,
    declarations,
}: {
    source: TestReviewSource;
    declarations: readonly TestDeclaration[];
}): TestHygieneFinding[] {
    return declarations.flatMap((declaration): TestHygieneFinding[] => {
        if (
            !declaration.skipped ||
            (declaration.skipReason ?? "").trim() !== "" ||
            parkedSkip({ content: source.content, line: declaration.line })
        ) {
            return [];
        }
        return [
            {
                rule: "skipped-test",
                file: source.path,
                line: declaration.line,
                message: `skipped test declaration "${declaration.skipMarker ?? "skipped"}": its assertions never run and no reason or ticket is recorded`,
            },
        ];
    });
}

/**
 * Literal-only tautologies matched in a declaration's masked body. A
 * comparison that cannot fail for any input proves nothing.
 */
const TAUTOLOGY_RULES: ReadonlyArray<{
    readonly pattern: RegExp;
    readonly derivation: string;
}> = [
    {
        pattern:
            /\bexpect\s*\(\s*(true|false|-?\d+(?:\.\d+)?)\s*\)\s*\.to(?:Be|Equal)\s*\(\s*\1\s*\)/g,
        derivation: "both operands of the assertion are the same literal",
    },
    {
        pattern:
            /\bexpect\s*\(\s*([\w.]+)\s*\)\s*\.to(?:Be|Equal)\s*\(\s*\1\s*\)/g,
        derivation: "both operands are the same expression",
    },
    {
        pattern:
            /\bAssert\.(?:Equal|AreEqual)\s*\(\s*(true|false|-?\d+(?:\.\d+)?)\s*,\s*\1\s*[,)]/g,
        derivation: "both operands of the assertion are the same literal",
    },
    {
        pattern: /\bAssert\.AreEqual\s*\(\s*([\w.]+)\s*,\s*\1\s*[,)]/g,
        derivation: "both operands are the same expression",
    },
    {
        pattern: /\bAssert\.(?:True|IsTrue)\s*\(\s*true\s*[,)]/g,
        derivation: "the asserted value is the literal true",
    },
    {
        pattern: /\bAssert\.(?:False|IsFalse)\s*\(\s*false\s*[,)]/g,
        derivation: "the asserted value is the literal false",
    },
];

/** 1-based line of an offset inside a declaration's body. */
function lineInBody({
    body,
    bodyLine,
    index,
}: {
    body: string;
    bodyLine: number;
    index: number;
}): number {
    let line = bodyLine;
    for (let i = 0; i < index; i++) {
        if (body[i] === "\n") {
            line++;
        }
    }
    return line;
}

/**
 * Tautological assertions in one source's declarations.
 *
 * The first pattern to claim a position wins, so a literal compared with
 * itself reports once, as a literal.
 */
function tautologyFindings({
    source,
    declarations,
}: {
    source: TestReviewSource;
    declarations: readonly TestDeclaration[];
}): TestHygieneFinding[] {
    return declarations.flatMap((declaration): TestHygieneFinding[] => {
        const body = declaration.maskedBody;
        if (body === null) {
            return [];
        }
        const claimed = new Set<number>();
        return TAUTOLOGY_RULES.flatMap((rule): TestHygieneFinding[] =>
            [...body.matchAll(rule.pattern)].flatMap(
                (match): TestHygieneFinding[] => {
                    const index = match.index ?? 0;
                    if (claimed.has(index)) {
                        return [];
                    }
                    claimed.add(index);
                    return [
                        {
                            rule: "literal-tautology",
                            file: source.path,
                            line: lineInBody({
                                body,
                                bodyLine: declaration.bodyLine,
                                index,
                            }),
                            message: `literal tautology in test "${declaration.name}": ${rule.derivation}, so it cannot fail`,
                        },
                    ];
                },
            ),
        );
    });
}

/** A comment-led body line that still carries an assertion call. */
const COMMENT_LED = /^(?:\/\/|\/\*|#|\*|--)/;

/** The leading comment marker and the space after it. */
const COMMENT_MARKER = /^(?:\/\/|\/\*|#|\*|--)\s*/;

/** An assertion verb inside a block, across the frameworks. */
const ASSERTION_VERB = /\b(?:Assert|assert|expect|should|verify)\b/;

/** Assertion call shapes the JavaScript frameworks share. */
const JS_ASSERTION_CALLS: readonly RegExp[] = [
    /\b(?:expect|assert|should)(?:[A-Z]\w*)?\s*\(/u,
    /\bassert\.\w+/u,
    /\bshould\.\w+/u,
];

/** Assertion call shapes the .NET frameworks share. */
const DOTNET_ASSERTION_CALLS: readonly RegExp[] = [
    /\bAssert\.\w+/u,
    /\bStringAssert\.\w+/u,
    /\bCollectionAssert\.\w+/u,
    /\b(?:Assert|Verify|Expect)(?:[A-Z]\w*)?\s*[(<]/u,
    /\.Should\s*\(/u,
    /\bAnd\.\w+\s*\(/u,
    /\bShould(?:Be|Not|Have|Contain|Match|Start|End|Equal|Satisfy|Throw)\w*\s*[(<]/u,
    /\bShould\.(?:Throw|NotThrow|CompleteIn)\w*\s*[(<]/u,
];

/** Assertion call shapes, keyed by the framework the declaration is for. */
const ASSERTION_CALLS: Readonly<Record<TestFramework, readonly RegExp[]>> = {
    jest: JS_ASSERTION_CALLS,
    vitest: JS_ASSERTION_CALLS,
    "node-test": JS_ASSERTION_CALLS,
    xunit: DOTNET_ASSERTION_CALLS,
    nunit: DOTNET_ASSERTION_CALLS,
    mstest: DOTNET_ASSERTION_CALLS,
};

/** An assertion call shape inside comment text. */
const ASSERTION_CALL =
    /\b(?:Assert|assert|expect|should|verify)(?:\.\w+\s*\(|\s*\()/;

/**
 * Assertion calls left behind in comments inside one source's declarations.
 * Only comment-led lines are read, so text that merely resembles a comment
 * inside a fixture string cannot trigger the rule.
 */
function commentedAssertionFindings({
    source,
    declarations,
}: {
    source: TestReviewSource;
    declarations: readonly TestDeclaration[];
}): TestHygieneFinding[] {
    return declarations.flatMap((declaration): TestHygieneFinding[] => {
        const body = declaration.body;
        if (body === null) {
            return [];
        }
        return body.split("\n").flatMap((raw, offset) => {
            const trimmed = raw.trim();
            if (!COMMENT_LED.test(trimmed)) {
                return [];
            }
            const text = trimmed.replace(COMMENT_MARKER, "");
            if (!ASSERTION_CALL.test(text)) {
                return [];
            }
            return [
                {
                    rule: "commented-out-assertion",
                    file: source.path,
                    line: declaration.bodyLine + offset,
                    message: `commented-out assertion in test "${declaration.name}": "${text}" — the assertion never runs`,
                },
            ];
        });
    });
}

/**
 * Parameterised declarations the scanner found no data source for: the
 * runner executes zero cases and reports green.
 */
function theoryWithoutDataFindings({
    source,
    declarations,
}: {
    source: TestReviewSource;
    declarations: readonly TestDeclaration[];
}): TestHygieneFinding[] {
    return declarations.flatMap((declaration): TestHygieneFinding[] => {
        if (declaration.dataSourceMissing !== true) {
            return [];
        }
        return [
            {
                rule: "theory-without-data",
                file: source.path,
                line: declaration.line,
                message: `parameterised test declaration "${declaration.name}" names no data source: the runner executes zero cases`,
            },
        ];
    });
}

/** Findings for declarations whose body makes no assertion at all. */
function noAssertionFindings({
    source,
    declarations,
}: {
    source: TestReviewSource;
    declarations: readonly TestDeclaration[];
}): TestHygieneFinding[] {
    return declarations.flatMap((declaration): TestHygieneFinding[] => {
        const body = declaration.maskedBody;
        if (
            body === null ||
            declaration.skipped ||
            ASSERTION_CALLS[declaration.framework].some((pattern) =>
                pattern.test(body),
            )
        ) {
            return [];
        }
        return [
            {
                rule: "no-assertions",
                file: source.path,
                line: declaration.line,
                message: `test declaration "${declaration.name}" contains no assertion call: it cannot fail for any input`,
            },
        ];
    });
}

/**
 * Async assertion calls that execute only when awaited or returned. The call
 * shape (`<` or `(`) keeps a regex literal or fixture string naming the
 * assertion from triggering the rule.
 */
const ASYNC_ASSERTION = /\b(?:ThrowsAsync|ThrowAsync)\s*[<(]|\.rejects\b/g;

/** Start of the statement containing `index`: after the last statement end. */
function statementStart(body: string, index: number): number {
    return (
        Math.max(
            body.lastIndexOf(";", index - 1),
            body.lastIndexOf("{", index - 1),
            body.lastIndexOf("}", index - 1),
        ) + 1
    );
}

/** End of the statement containing `index`, including its semicolon. */
function statementEnd(body: string, index: number): number {
    const end = body.indexOf(";", index);
    return end === -1 ? body.length : end + 1;
}

/** Collapse whitespace and cap length, so evidence stays one readable line. */
function collapse(text: string, cap = 100): string {
    const collapsed = text.replace(/\s+/gu, " ").trim();
    return collapsed.length > cap ? `${collapsed.slice(0, cap)}...` : collapsed;
}

/**
 * Async assertion statements that are neither awaited nor returned, so the
 * assertion never executes. Expression-arrow bodies return implicitly, which
 * the runner awaits, so only block bodies are read.
 */
function unawaitedAssertionFindings({
    source,
    declarations,
}: {
    source: TestReviewSource;
    declarations: readonly TestDeclaration[];
}): TestHygieneFinding[] {
    return declarations.flatMap((declaration): TestHygieneFinding[] => {
        const body = declaration.maskedBody;
        // A delimited block body starts at its brace; an arrow expression
        // starts at its first token and returns implicitly.
        if (!body?.startsWith("{")) {
            return [];
        }
        return [...body.matchAll(ASYNC_ASSERTION)].flatMap(
            (match): TestHygieneFinding[] => {
                const index = match.index ?? 0;
                const start = statementStart(body, index);
                const prefix = body.slice(start, index);
                if (
                    /(?:^|[^A-Za-z0-9_$])await\b/u.test(prefix) ||
                    /\breturn\b/u.test(prefix)
                ) {
                    return [];
                }
                return [
                    {
                        rule: "unawaited-async-assertion",
                        file: source.path,
                        line: lineInBody({
                            body,
                            bodyLine: declaration.bodyLine,
                            index,
                        }),
                        message: `unawaited async assertion in test "${declaration.name}": "${collapse(body.slice(start, statementEnd(body, index)))}" — it never runs unless awaited or returned`,
                    },
                ];
            },
        );
    });
}

/** A catch clause with its block. A promise `.catch(` does not match. */
const CATCH_OPEN = /\bcatch\s*(?:(?:\([^)]*\))\s*)?\{/g;

/** Index of the brace closing the one at `open`, or the last index. */
function blockEnd(text: string, open: number): number {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
        if (text[index] === "{") {
            depth++;
        } else if (text[index] === "}") {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return text.length - 1;
}

/**
 * Whether a catch body only assigns flags and a later assertion reads one.
 * The documented flag-then-assert exception: a lexical read, not a parser's.
 */
function flagThenAssert({
    contents,
    after,
}: {
    contents: string;
    after: string;
}): boolean {
    if (!ASSERTION_VERB.test(after)) {
        return false;
    }
    return [...contents.matchAll(/\b([A-Za-z_$][\w$]*)\s*=(?!=)/gu)].some(
        (match) =>
            new RegExp(String.raw`\b${match[1] ?? ""}\b`, "u").test(after),
    );
}

/**
 * Catch blocks that neither assert nor rethrow: the test passes when anything
 * throws, including the wrong exception.
 */
function swallowedExceptionFindings({
    source,
    declarations,
}: {
    source: TestReviewSource;
    declarations: readonly TestDeclaration[];
}): TestHygieneFinding[] {
    return declarations.flatMap((declaration): TestHygieneFinding[] => {
        const body = declaration.maskedBody;
        if (body === null) {
            return [];
        }
        return [...body.matchAll(CATCH_OPEN)].flatMap(
            (match): TestHygieneFinding[] => {
                const index = match.index ?? 0;
                const open = index + match[0].length - 1;
                const close = blockEnd(body, open);
                const contents = body.slice(open + 1, close);
                if (
                    ASSERTION_VERB.test(contents) ||
                    /\bthrow\b/u.test(contents) ||
                    flagThenAssert({ contents, after: body.slice(close + 1) })
                ) {
                    return [];
                }
                return [
                    {
                        rule: "swallowed-exception",
                        file: source.path,
                        line: lineInBody({
                            body,
                            bodyLine: declaration.bodyLine,
                            index,
                        }),
                        message: `swallowed exception in test "${declaration.name}": "${collapse(match[0].replace(/\{$/u, ""))}" neither asserts nor rethrows, so the test passes when anything throws`,
                    },
                ];
            },
        );
    });
}

/** Name fragments that mark an environment variable as credential-like. */
const SECRET_NAME =
    /(?:token|secret|password|passwd|api[_-]?key|apikey|credential|authoriz(?:ation|ed))|auth(?!or)/iu;

/** Findings for an OpenCollection request file. */
function collectionFindings(source: TestReviewSource): TestHygieneFinding[] {
    const request = readCollectionRequest({
        path: source.path,
        content: source.content,
    });
    if (request === null) {
        return [];
    }
    const findings: TestHygieneFinding[] = [];
    if (!request.hasAssertions && !request.hasTestsScript) {
        findings.push({
            rule: "no-tests",
            file: source.path,
            line: 1,
            message: `OpenCollection request "${request.name}" declares no assertions and no tests script: nothing checks the response`,
        });
    }
    if (request.url !== null) {
        findings.push({
            rule: "hardcoded-host",
            file: source.path,
            line: request.url.line,
            message: `OpenCollection request "${request.name}" pins a literal scheme and host: "${request.url.text}" — use a variable so the request runs against any environment`,
        });
    }
    if (request.credential !== null) {
        findings.push({
            rule: "plaintext-credential",
            file: source.path,
            line: request.credential.line,
            message: `OpenCollection request "${request.name}" carries a literal credential: "${request.credential.text}" — the value is withheld; use an environment variable`,
        });
    }
    return findings;
}

/** Findings for an OpenCollection environment file. */
function environmentFindings(source: TestReviewSource): TestHygieneFinding[] {
    if (!isEnvironmentPath(source.path)) {
        return [];
    }
    return readEnvironmentVariables(source.content).flatMap(
        (variable): TestHygieneFinding[] => {
            if (
                !SECRET_NAME.test(variable.name) ||
                variable.secret ||
                variable.value === "" ||
                variable.value.startsWith("{{")
            ) {
                return [];
            }
            return [
                {
                    rule: "unlabelled-secret-var",
                    file: source.path,
                    line: variable.line,
                    message: `environment variable "${variable.name}" holds a literal value and is not marked secret: true, so the value is committed`,
                },
            ];
        },
    );
}

/** All findings from one source, in line order. */
function sourceFindings(source: TestReviewSource): TestHygieneFinding[] {
    const masked = maskTestSource(source.content);
    const declarations = scanTestDeclarations({
        path: source.path,
        content: source.content,
    });
    return [
        ...collectionFindings(source),
        ...environmentFindings(source),
        ...matchFindings({
            source,
            masked,
            rule: "focused-test",
            pattern: FOCUSED_TEST,
            message: (marker) =>
                `focused test declaration "${marker}": every other test in the suite is skipped`,
        }),
        ...matchFindings({
            source,
            masked,
            rule: "focused-suite",
            pattern: FOCUSED_SUITE,
            message: (marker) =>
                `focused suite declaration "${marker}": every other suite in the file is skipped`,
        }),
        ...skippedFindings({ source, declarations }),
        ...theoryWithoutDataFindings({ source, declarations }),
        ...tautologyFindings({ source, declarations }),
        ...commentedAssertionFindings({ source, declarations }),
        ...noAssertionFindings({ source, declarations }),
        ...unawaitedAssertionFindings({ source, declarations }),
        ...swallowedExceptionFindings({ source, declarations }),
    ];
}

/** Deterministic code-unit ordering (never the ambient locale). */
function compareFindings(
    left: TestHygieneFinding,
    right: TestHygieneFinding,
): number {
    if (left.file !== right.file) {
        return left.file < right.file ? -1 : 1;
    }
    if (left.line !== right.line) {
        return left.line - right.line;
    }
    if (left.rule === right.rule) {
        return 0;
    }
    return left.rule < right.rule ? -1 : 1;
}

/**
 * Run the always-on rule set over the named sources.
 *
 * @param sources Files to read, already read from disk by the caller.
 * @returns Findings ordered by file, line and rule.
 */
export function reviewTestSources(
    sources: readonly TestReviewSource[],
): TestHygieneFinding[] {
    return sources.flatMap(sourceFindings).sort(compareFindings);
}
