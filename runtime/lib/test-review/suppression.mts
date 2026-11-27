// lib/test-review/suppression.mts — the one why-note grammar.
//
// A review-tier lead is suppressed by a note in the contiguous comment block
// immediately above the test declaration, in one frame:
//
//   // Why use <rule-id> here: <reason>
//   // Why not use <rule-id> here: <reason>
//
// This module owns the frame, the one alias, the vacuous stop-list and the
// comment block a note must sit in. Tier membership stays in rules.mts, so the
// engine decides which ids a note may silence and which are faults.
//
// The `i` flag on the frame is deliberate: a wrong-case id (say `Sleep`) is
// read as a note and then rejected by the exact-case catalogue lookup, so it
// reports as misspelt instead of vanishing.
//
// Deliberate ceiling (ponytail): a note is read above the anchor line the
// caller supplies — the test declaration, or a finding's own line where the
// finding sits outside any declaration. A note above unrelated production
// code, a suite or a file suppresses nothing and is not reported. Upgrade if a
// file-level note is ever wanted.

/** The one accepted alias, mapped to the rule id it names. */
export const NOTE_ALIASES: Readonly<Record<string, string>> = {
    property: "property-trigger-unmet",
};

/**
 * Reasons that restate the lead instead of answering it. Compared
 * case-insensitively after trailing sentence punctuation is stripped.
 */
export const VACUOUS_REASONS: ReadonlySet<string> = new Set([
    "",
    "legitimate",
    "intentional",
    "intended",
    "required",
    "by design",
    "deliberate",
    "acceptable",
    "known",
    "fine",
    "ok",
    "okay",
    "none",
    "n/a",
    "na",
    "not applicable",
    "tbd",
    "todo",
]);

/** The note frame, applied to a line with its comment marker removed. */
const NOTE_FRAME =
    /^\s*why\s+(?:not\s+)?use\s+([a-z][a-z0-9-]*)(?:\s+here)?\s*:(.*)$/iu;

/** The comment marker a note line starts with. */
const NOTE_MARKER = /^[ \t]*(?:\/\/+|\/\*+|\*+\/?|--|#)[ \t]*/u;

/** A line the contiguous block above a declaration can span. */
const COMMENT_BLOCK_LINE = /^(?:\/\/|\/\*|\*|\*\/|\[)/u;

/** One note as written: the rule token and the reason. */
export interface SuppressionNote {
    /** The rule id as written; case is preserved for the catalogue lookup. */
    readonly rule: string;
    /** The reason as written, trimmed. */
    readonly reason: string;
}

/** One line of a comment block above a declaration. */
export interface CommentLine {
    /** 1-based line number. */
    readonly line: number;
    /** The raw line, marker included. */
    readonly text: string;
}

/**
 * The contiguous comment lines immediately above `line`, oldest first.
 * Comment, block-comment and attribute lines continue the block; a blank line
 * or a code line ends it.
 *
 * @param root0 the parameter object
 * @param root0.content Full source text.
 * @param root0.line 1-based line the block must touch.
 * @returns The block's lines, empty when the line above is not a comment.
 */
export function commentBlockAbove({
    content,
    line,
}: {
    readonly content: string;
    readonly line: number;
}): CommentLine[] {
    const lines = content.split("\n");
    const block: CommentLine[] = [];
    for (let index = line - 2; index >= 0; index--) {
        const text = lines[index] ?? "";
        if (!COMMENT_BLOCK_LINE.test(text.trim())) {
            break;
        }
        block.unshift({ line: index + 1, text });
    }
    return block;
}

/**
 * Read one note from a comment line.
 *
 * @param text The raw line, comment marker included.
 * @returns The rule token and reason, or `null` when the line is not a note.
 */
export function readNote(text: string): SuppressionNote | null {
    const match = NOTE_FRAME.exec(text.replace(NOTE_MARKER, ""));
    if (match === null) {
        return null;
    }
    return {
        rule: match[1] ?? "",
        reason: (match[2] ?? "").trim(),
    };
}

/**
 * Resolve the one documented alias.
 *
 * @param rule The rule token as written.
 * @returns The rule id the token names; unknown tokens are returned unchanged.
 */
export function resolveRule(rule: string): string {
    return NOTE_ALIASES[rule] ?? rule;
}

/**
 * Whether a reason restates the lead instead of answering it.
 *
 * @param reason The note's reason as written.
 * @returns True for an empty or restating reason.
 */
export function isVacuous(reason: string): boolean {
    const normalised = reason
        .trim()
        .toLowerCase()
        .replace(/[.!?]+/gu, "")
        .trim();
    return VACUOUS_REASONS.has(normalised);
}
