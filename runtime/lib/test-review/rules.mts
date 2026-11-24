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
// `PROJ-123`, a URL) in the declaration's own line or the contiguous comment
// block above it parks the skip; a C# `Skip = "…"` or PHPUnit
// `markTestSkipped("…")` reason will too once those stacks land.
//
// Deliberate ceiling (ponytail): the marker regex reads contiguous call text,
// so `it` split from `.only` across lines reads as unfocused — the scanner's
// declaration head has the same shape. The marker also matches wherever the
// call text appears in masked code, not only at a declaration head.

import { lineAt, scanTestDeclarations } from "./declarations.mts";
import { maskTestSource } from "./mask.mts";

/** The rule ids the always-on pass can report. */
export const ALWAYS_ON_RULES = [
    "focused-test",
    "focused-suite",
    "skipped-test",
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
const TICKET = /(?:#\d+\b|\b[A-Z][A-Z0-9]{1,}-\d+\b|https?:\/\/\S+)/;

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
        if (trimmed === "" || !/^(?:\/\/|\/\*|\*|\*\/)/.test(trimmed)) {
            break;
        }
        context.unshift(raw);
    }
    return TICKET.test(context.join("\n"));
}

/** Findings for skipped declarations that carry no reason or ticket. */
function skippedFindings(source: TestReviewSource): TestHygieneFinding[] {
    return scanTestDeclarations({
        path: source.path,
        content: source.content,
    }).flatMap((declaration): TestHygieneFinding[] => {
        if (
            !declaration.skipped ||
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

/** All findings from one source, in line order. */
function sourceFindings(source: TestReviewSource): TestHygieneFinding[] {
    const masked = maskTestSource(source.content);
    return [
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
        ...skippedFindings(source),
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
    return left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0;
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
