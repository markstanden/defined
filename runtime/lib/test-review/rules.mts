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

import { maskTestSource } from "./mask.mts";

/** The rule ids the always-on pass can report. */
export const ALWAYS_ON_RULES = ["focused-test", "focused-suite"] as const;

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

/** 1-based line holding the offset. */
function lineAt({
    content,
    index,
}: {
    content: string;
    index: number;
}): number {
    return content.slice(0, index).split("\n").length;
}

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
