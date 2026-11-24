// lib/test-review/declarations.mts — test declarations for the stacks the
// engine reads.
//
// The always-on rules that read a test body need the declaration around it: its
// name, line, body and the skip/focus modifiers on its head. `scanTestDeclarations`
// dispatches by path: a JavaScript/TypeScript source is read by the JS scanner
// over offset-preserving masked source (lib/test-review/mask.mts), a `.cs`
// source by the C# scanner. A declaration quoted inside a string or a comment
// is data, not a test. A JS file with no vitest, Jest or node:test marker is
// not a test file; a C# method with no test attribute block above it is not a
// test declaration and yields nothing.
//
// Public surface:
//   scanTestDeclarations({ path, content }) — declarations in file order
//   lineAt({ content, index }) — the 1-based line holding an offset
//
// Deliberate ceiling (ponytail): a lexical scanner, not a parser. JS titles are
// classified by their first token, bodies by bracket matching, and a method
// named `it`/`test`/`specify` on an object is not a declaration. C# supports
// one level of generic arguments and requires at least one modifier on the
// method; attributes are read from the contiguous lines above the signature,
// with comment and doc lines walked over but never read as attributes. The
// mask is JavaScript-shaped, so C# verbatim/interpolated strings may end
// early. Upgrade to a parser if exotic styles ever earn the dependency.

import { maskTestSource } from "./mask.mts";

/** The test frameworks the scanner recognises. */
export type TestFramework =
    "node-test" | "jest" | "vitest" | "xunit" | "nunit" | "mstest";

/** One JavaScript/TypeScript test declaration and the body it opens. */
export interface TestDeclaration {
    /** Repo-relative path of the source. */
    readonly path: string;
    /** 1-based line of the declaration head. */
    readonly line: number;
    /** The title as written, without its delimiters. */
    readonly name: string;
    /** The framework the file is written for. */
    readonly framework: TestFramework;
    /** Whether the head marks the declaration skipped. */
    readonly skipped: boolean;
    /** The skip marker as written, when the declaration is skipped. */
    readonly skipMarker?: string;
    /** The reason the framework records for a skip, when it records one. */
    readonly skipReason?: string;
    /** Whether the head marks the declaration focused (`.only`). */
    readonly focused: boolean;
    /** The focus marker as written, when the declaration is focused. */
    readonly focusMarker?: string;
    /** Whether the declaration is parameterised but names no data source. */
    readonly dataSourceMissing?: boolean;
    /** Raw body text, or `null` when the declaration has no delimited body. */
    readonly body: string | null;
    /** The body with strings and comments blanked, or `null`. */
    readonly maskedBody: string | null;
    /** 1-based line the body starts on (the brace or the first expression). */
    readonly bodyLine: number;
}

/** How a declaration head marks skipping or focus, if at all. */
interface ModifierFlags {
    readonly skipped: boolean;
    readonly focused: boolean;
    readonly skipMarker?: string;
    readonly focusMarker?: string;
}

/** A title the scanner read from one declaration. */
interface TitleShape {
    readonly name: string;
}

/** 1-based line number for a character offset. */
export function lineAt({
    content,
    index,
}: {
    content: string;
    index: number;
}): number {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) {
        if (content[i] === "\n") {
            line++;
        }
    }
    return line;
}

/**
 * Whether an offset is live code rather than a string or comment.
 *
 * `maskTestSource` blanks both while preserving offsets, so a character that
 * changed between the source and its mask marks the offset as data.
 */
function inCode(content: string, masked: string, index: number): boolean {
    let offset = index;
    while (content[offset] === " " || content[offset] === "\t") {
        offset++;
    }
    return masked[offset] === content[offset];
}

/** Offset of the next non-whitespace character, or the end of the text. */
function skipWhitespace(text: string, from: number): number {
    let i = from;
    while (i < text.length && /\s/.test(text[i] ?? "")) {
        i++;
    }
    return i;
}

/** Whether a character opens a bracket. */
function isOpener(char: string): boolean {
    return char === "(" || char === "[" || char === "{";
}

/** Whether a character closes a bracket. */
function isCloser(char: string): boolean {
    return char === ")" || char === "]" || char === "}";
}

/** A non-empty span from `start` to `end`, or `null` when empty. */
function nonEmptySpan(start: number, end: number): [number, number] | null {
    return end > start ? [start, end] : null;
}

/**
 * Index just past the closing quote that starts at `start`, honouring
 * backslash escapes. Returns `text.length` when the literal is unterminated.
 */
function quotedEnd(text: string, start: number, quote: string): number {
    let end = start + 1;
    while (end < text.length) {
        if (text[end] === "\\") {
            end += 2;
            continue;
        }
        end++;
        if (text[end - 1] === quote) {
            break;
        }
    }
    return end;
}

/** Brace-matched span for a block-bodied declaration, else `null`. */
function bodySpan(masked: string, from: number): [number, number] | null {
    const open = masked.indexOf("{", from);
    if (open === -1) {
        return null;
    }
    const semicolon = masked.indexOf(";", from);
    if (semicolon !== -1 && semicolon < open) {
        return null;
    }
    let depth = 0;
    for (let i = open; i < masked.length; i++) {
        if (masked[i] === "{") {
            depth++;
        } else if (masked[i] === "}") {
            depth--;
            if (depth === 0) {
                return [open, i + 1];
            }
        }
    }
    return null;
}

/**
 * Bracket-matched span for an expression-bodied arrow test.
 *
 * Starts after the `=>` and stops at the closing bracket of the `it(...)`
 * call, or at a top-level comma when the arrow is not the final argument (for
 * example a trailing timeout). Brackets inside masked strings are blank, so
 * the count cannot be fooled by them.
 *
 * ponytail: lexical delimiting, not a parser. The arrow window is bounded by
 * the caller; a nested arrow inside the expression is delimited by bracket
 * depth, not by syntax. Upgrade if exotic styles turn up.
 */
function expressionSpan(masked: string, from: number): [number, number] | null {
    const start = skipWhitespace(masked, from);
    let depth = 0;

    for (let i = start; i < masked.length; i++) {
        const char = masked[i] ?? "";
        const atTop = depth === 0;
        if (isOpener(char)) {
            depth++;
            continue;
        }
        if (isCloser(char)) {
            if (atTop) {
                return nonEmptySpan(start, i);
            }
            depth--;
            continue;
        }
        if (char === "," && atTop) {
            return nonEmptySpan(start, i);
        }
    }
    return null;
}

/** Body span for a JavaScript test: arrow expression first, brace otherwise. */
function javaScriptBodySpan(
    masked: string,
    index: number,
): [number, number] | null {
    const arrow = masked.indexOf("=>", index);
    if (arrow === -1 || arrow - index >= 500) {
        return bodySpan(masked, index);
    }
    return expressionSpan(masked, arrow + 2) ?? bodySpan(masked, arrow + 2);
}

/** Body text, masked text and the line the body starts on. */
function bodySlice(
    content: string,
    masked: string,
    span: [number, number] | null,
    declarationLine: number,
): {
    readonly body: string | null;
    readonly maskedBody: string | null;
    readonly bodyLine: number;
} {
    if (span === null) {
        return { body: null, maskedBody: null, bodyLine: declarationLine };
    }
    return {
        body: content.slice(span[0], span[1]),
        maskedBody: masked.slice(span[0], span[1]),
        bodyLine: lineAt({ content, index: span[0] }),
    };
}

/**
 * Offset where a title expression ends: the first top-level comma, or the
 * bracket that closes the declaration's argument list. Brackets inside the
 * expression are depth-counted on the masked text, so a call's own commas are
 * not boundaries and a comma inside a string cannot end the title.
 */
function titleExpressionEnd(masked: string, start: number): number {
    let depth = 0;
    for (let i = start; i < masked.length; i++) {
        const char = masked[i] ?? "";
        if (isOpener(char)) {
            depth++;
        } else if (isCloser(char)) {
            if (depth === 0) {
                return i;
            }
            depth--;
        } else if (char === "," && depth === 0) {
            return i;
        }
    }
    return masked.length;
}

/** An identifier chain that can start a title: `title`, `row.label`, `$x`. */
const IDENTIFIER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/;

/** A computed title: the whole expression, whitespace collapsed to one line. */
function computedTitle(
    content: string,
    masked: string,
    start: number,
): TitleShape {
    const end = titleExpressionEnd(masked, start);
    return {
        name: content.slice(start, end).replace(/\s+/g, " ").trim(),
    };
}

/** Whether the title is continued by `+` or `?` and so computed. */
function titleContinues(
    content: string,
    masked: string,
    from: number,
): boolean {
    const next = content[skipWhitespace(masked, from)] ?? "";
    return next === "+" || next === "?";
}

/** A quoted or backtick title: its inner text, or the whole expression. */
function quotedTitle(
    content: string,
    masked: string,
    start: number,
    quote: string,
): TitleShape {
    const end = quotedEnd(content, start, quote);
    if (titleContinues(content, masked, end)) {
        return computedTitle(content, masked, start);
    }
    const closed = content[end - 1] === quote ? end - 1 : end;
    return { name: content.slice(start + 1, closed) };
}

/** An identifier-led title, classified by what follows the chain. */
function identifierTitle(
    content: string,
    masked: string,
    start: number,
): TitleShape | null {
    const chain = IDENTIFIER_CHAIN.exec(content.slice(start));
    if (chain === null) {
        return null;
    }
    const identifier = chain[0];
    // A body callback is not a title; a title-less declaration is left out.
    if (identifier === "async" || identifier === "function") {
        return null;
    }
    const tail = start + identifier.length;
    // A tagged template is data, so the mask blanks it; read the raw text.
    if (content[skipWhitespace(content, tail)] === "`") {
        return computedTitle(content, masked, start);
    }
    const next = content[skipWhitespace(masked, tail)] ?? "";
    if (next === ",") {
        return { name: identifier };
    }
    if (next === "(" || titleContinues(content, masked, tail)) {
        return computedTitle(content, masked, start);
    }
    if (identifier === "await") {
        return computedTitle(content, masked, start);
    }
    return null;
}

/** Classify the first argument of a test declaration; `null` when title-less. */
function javascriptTitle(
    content: string,
    masked: string,
    start: number,
): TitleShape | null {
    const first = content[start] ?? "";
    if (first === '"' || first === "'" || first === "`") {
        return quotedTitle(content, masked, start, first);
    }
    return identifierTitle(content, masked, start);
}

/** How a declaration head marks skipping or focus, if at all. */
function modifierFlags(prefix: string): ModifierFlags {
    const modifier = /\b(it|test|specify)\.(skip|todo|only)\b/.exec(prefix);
    if (modifier === null) {
        return { skipped: false, focused: false };
    }
    const [, call = "", kind = ""] = modifier;
    if (kind === "only") {
        return { skipped: false, focused: true, focusMarker: `${call}.only` };
    }
    return { skipped: true, skipMarker: `${call}.${kind}`, focused: false };
}

/** The JavaScript frameworks the JS scanner recognises. */
type JavaScriptFramework = Extract<
    TestFramework,
    "node-test" | "jest" | "vitest"
>;

/** The framework a JavaScript test file is written for, or `null` if none. */
function frameworkOf(content: string): JavaScriptFramework | null {
    if (/from\s+["']vitest["']|\bvitest\b/.test(content)) {
        return "vitest";
    }
    if (/@jest\/globals|\bjest\b/.test(content)) {
        return "jest";
    }
    if (/from\s+["']node:test["']|\bnode:test\b/.test(content)) {
        return "node-test";
    }
    return null;
}

/**
 * One declaration head: `it(`, `it.each(cases)(`, `test.only(` and the like.
 * A head may not follow a `.`: `regex.test(...)` is a method call, not a test
 * declaration, and its arguments are not titles.
 *
 * Sonar S5843 (complexity 24, limit 20): the alternation is the declaration
 * grammar the oracle parity was measured against. Splitting the literal would
 * fork that grammar; kept deliberately.
 */
const DECLARATION_HEAD =
    /(?<!\.)\b(it|test|specify)(?:\.\w+)?(?:\([^)]*\)|\[[^\]]*\]|`[^`]*`)?\s*\(\s*/g;

/**
 * Read every JavaScript/TypeScript test declaration in one source.
 *
 * @param root0 the parameter object
 * @param root0.path Repo-relative path of the file.
 * @param root0.content Full contents of the file.
 * @returns Declarations in file order, title-less heads left out; empty when
 *   the file carries no framework marker.
 */
function scanJavaScriptDeclarations({
    path,
    content,
}: {
    readonly path: string;
    readonly content: string;
}): TestDeclaration[] {
    const framework = frameworkOf(content);
    if (framework === null) {
        return [];
    }
    const masked = maskTestSource(content);
    const tests: TestDeclaration[] = [];

    for (const match of content.matchAll(DECLARATION_HEAD)) {
        const index = match.index ?? 0;
        if (!inCode(content, masked, index)) {
            continue;
        }
        const head = match[0];
        const title = javascriptTitle(content, masked, index + head.length);
        if (title === null) {
            continue;
        }
        const line = lineAt({ content, index });
        const span = javaScriptBodySpan(masked, index);
        const { body, maskedBody, bodyLine } = bodySlice(
            content,
            masked,
            span,
            line,
        );
        tests.push({
            path,
            line,
            name: title.name,
            framework,
            ...modifierFlags(head),
            body,
            maskedBody,
            bodyLine,
        });
    }
    return tests;
}

/**
 * A C# method head: modifiers, a return type, a name and its argument list.
 *
 * Sonar S5843 (complexity 32, limit 20): the modifier run and the type/name
 * split are one grammar, pinned by the declaration tests and the corpus
 * parity. Splitting the literal would fork that grammar; kept deliberately.
 */
const DOTNET_METHOD =
    /^[ \t]*(?:(?:public|private|protected|internal|static|async|virtual|override|sealed|partial|new|unsafe|extern|abstract)\s+)+[A-Za-z_][\w,.?[\]]*(?:<[^>]*>)?[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;

/** A test attribute that makes the method below it a declaration. */
const DOTNET_TEST_ATTRIBUTE =
    /\[\s*(Fact|Theory|Test|TestCase|TestMethod|DataTestMethod|InlineData|MemberData|ClassData|DataRow)\b/u;

/** A line the attribute block above a C# method can span. */
const DOTNET_ANNOTATION_LINE = /^(?:\[|#\[|\/\*\*|\*|\*\/|\/\/)/u;
/**
 * The contiguous attribute lines immediately above a method. Comment and doc
 * lines are walked over but not returned, so a commented-out `[Fact]` cannot
 * make the method below it a test. Stops at the first line that is neither an
 * attribute nor a comment, or at a blank line once the block has started;
 * capped at 16 lines.
 */
function precedingAttributes({
    content,
    declarationLine,
}: {
    content: string;
    declarationLine: number;
}): string {
    const lines = content.split("\n");
    const collected: string[] = [];
    for (
        let index = declarationLine - 2;
        index >= 0 && collected.length < 16;
        index--
    ) {
        const trimmed = (lines[index] ?? "").trim();
        if (trimmed === "") {
            if (collected.length > 0) {
                break;
            }
            continue;
        }
        if (!DOTNET_ANNOTATION_LINE.test(trimmed)) {
            break;
        }
        collected.unshift(trimmed);
    }
    return collected.filter((line) => line.startsWith("[")).join("\n");
}

/** The C# framework an attribute block names. */
function dotNetFramework(
    annotations: string,
): Extract<TestFramework, "xunit" | "nunit" | "mstest"> {
    if (
        /\b(?:Fact|Theory|InlineData|MemberData|ClassData)\b/u.test(annotations)
    ) {
        return "xunit";
    }
    if (/\b(?:TestMethod|DataTestMethod)\b/u.test(annotations)) {
        return "mstest";
    }
    return "nunit";
}

/**
 * The reason a C# attribute block records for a skip: the annotation text, an
 * empty string for a marker with no text, or `null` when the method is not
 * skipped.
 */
function dotNetSkipReason(annotations: string): string | null {
    const skip = /\bSkip\s*=\s*"([^"]*)"/u.exec(annotations);
    if (skip !== null) {
        return skip[1] ?? "";
    }
    const ignore = /\[Ignore\b(?:\s*\(\s*"([^"]*)")?/u.exec(annotations);
    if (ignore !== null) {
        return ignore[1] ?? "";
    }
    return null;
}

/** Whether a parameterised C# declaration names no data source. */
function dotNetDataSourceMissing(annotations: string): boolean {
    return (
        /\b(?:Theory|DataTestMethod)\b/u.test(annotations) &&
        !/\b(?:InlineData|MemberData|ClassData|DataRow|DynamicData)\b/u.test(
            annotations,
        )
    );
}

/** Read every C# test declaration in one source. */
function scanDotNetDeclarations({
    path,
    content,
}: {
    readonly path: string;
    readonly content: string;
}): TestDeclaration[] {
    // Cheap file-level gate, like the JS framework marker: a source with no
    // test attribute anywhere cannot declare a test, so the method scan is
    // skipped for production files.
    if (!DOTNET_TEST_ATTRIBUTE.test(content)) {
        return [];
    }
    const masked = maskTestSource(content);
    const declarations: TestDeclaration[] = [];

    for (const match of content.matchAll(DOTNET_METHOD)) {
        const index = match.index ?? 0;
        if (!inCode(content, masked, index)) {
            continue;
        }
        const line = lineAt({ content, index });
        const annotations = precedingAttributes({
            content,
            declarationLine: line,
        });
        if (!DOTNET_TEST_ATTRIBUTE.test(annotations)) {
            continue;
        }
        const skipReason = dotNetSkipReason(annotations);
        const { body, maskedBody, bodyLine } = bodySlice(
            content,
            masked,
            bodySpan(masked, index),
            line,
        );
        declarations.push({
            path,
            line,
            name: match[1] ?? "",
            framework: dotNetFramework(annotations),
            skipped: skipReason !== null,
            ...(skipReason === null || skipReason === "" ? {} : { skipReason }),
            focused: false,
            dataSourceMissing: dotNetDataSourceMissing(annotations),
            body,
            maskedBody,
            bodyLine,
        });
    }
    return declarations;
}

/**
 * Read every test declaration in one source, by stack.
 *
 * @param root0 the parameter object
 * @param root0.path Repo-relative path of the file; `.cs` selects the C# scanner.
 * @param root0.content Full contents of the file.
 * @returns Declarations in file order.
 */
export function scanTestDeclarations({
    path,
    content,
}: {
    readonly path: string;
    readonly content: string;
}): TestDeclaration[] {
    return path.endsWith(".cs")
        ? scanDotNetDeclarations({ path, content })
        : scanJavaScriptDeclarations({ path, content });
}
