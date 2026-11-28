// lib/test-review/mask.mts — offset-preserving masking for test source.
//
// Every test-hygiene rule reads masked source: a declaration, phase label or
// assertion quoted inside a string or comment is data, not test code. Masking
// blanks strings and comments with spaces, keeps every newline, and leaves all
// offsets aligned with the original content, so a regex match index still maps
// to the right line.
//
// Public surface:
//   maskTestSource(content, { comments }) — the masked source, same length as
//   the input; `comments: "keep"` blanks strings but leaves comment text
//   verbatim for rules that read phase labels out of comments.
//
// A quote inside a comment never opens a literal: line and block comments are
// consumed before quotes are considered, in both modes. An unterminated literal
// masks to the end of the source, matching the scanner's reading.
//
// Regex literals are masked too, since a bracket inside a pattern would
// otherwise close a bracket-matched span. A `/` starts a regex only after an
// operator, a bracket or an arrow; after a name or a close bracket it is
// division. The engine is a frame stack, so template literals nest: a `${`
// pushes an interpolation frame, a nested template inside it pushes a literal
// frame of its own, and each closing delimiter pops back to the frame that
// opened it. Interpolation content is still masked as data, but its structure
// is tracked, so an inner backtick can no longer close the outer literal. A
// regex after a keyword (`return /x/`) is read as division; mask.test.mts pins
// both ceilings, so upgrade to token-aware parsing only if a blind spot ever
// earns the dependency.

type Quote = '"' | "'" | "`";

/** Whether comment text is blanked (`blank`) or kept (`keep`). */
export type MaskComments = "blank" | "keep";

interface CodeFrame {
    readonly kind: "code";
}

interface LineCommentFrame {
    readonly kind: "line-comment";
}

interface BlockCommentFrame {
    readonly kind: "block-comment";
}

interface LiteralFrame {
    readonly kind: "literal";
    readonly quote: Quote;
}

interface RegexFrame {
    readonly kind: "regex";
    readonly inClass: boolean;
}

/** Code inside a template interpolation; `braces` counts unmatched `{`. */
interface InterpolationFrame {
    readonly kind: "interpolation";
    readonly braces: number;
}

type Frame =
    | CodeFrame
    | LineCommentFrame
    | BlockCommentFrame
    | LiteralFrame
    | RegexFrame
    | InterpolationFrame;

interface Walk {
    content: string;
    out: string[];
    index: number;
    /** Keep comment text verbatim for rules that read labels from comments. */
    keep: boolean;
    /** Enclosing constructs, innermost last. */
    frames: Frame[];
}

/** Replace one character with a space unless it is the newline we preserve. */
function blank({ out, index }: { out: string[]; index: number }): void {
    if (out[index] !== "\n") {
        out[index] = " ";
    }
}

/** Replace both characters of a two-character delimiter with spaces. */
function blankPair({ out, index }: { out: string[]; index: number }): void {
    blank({ out, index });
    if (index + 1 < out.length) {
        blank({ out, index: index + 1 });
    }
}

/**
 * Characters after which a `/` opens a regex literal rather than division.
 * A close bracket after an arrow (`) => /x/`) or a keyword slips through and
 * reads as division; that is a documented ceiling.
 */
const REGEX_PREFIX = new Set([..."(,=:[!&|?{};+-*%~^<>"]);

/** Whether the `/` at `index` opens a regex literal. */
function startsRegex(content: string, index: number): boolean {
    let before = index - 1;
    while (before >= 0 && /\s/u.test(content[before] ?? "")) {
        before--;
    }
    return before < 0 || REGEX_PREFIX.has(content[before] ?? "");
}

/** Whether a character opens a quoted literal. */
function isQuote(char: string): char is Quote {
    return char === '"' || char === "'" || char === "`";
}

/**
 * Open the comment, regex or literal starting at `index`, blanking its
 * delimiter; `null` when the character opens no construct.
 */
function startConstruct({
    content,
    out,
    index,
    keep,
    frames,
}: Walk): number | null {
    const char = content[index];
    const next = content[index + 1];
    if (char === "/" && next === "/") {
        frames.push({ kind: "line-comment" });
        if (!keep) {
            blankPair({ out, index });
        }
        return index + 2;
    }
    if (char === "/" && next === "*") {
        frames.push({ kind: "block-comment" });
        if (!keep) {
            blankPair({ out, index });
        }
        return index + 2;
    }
    if (char === "/" && startsRegex(content, index)) {
        out[index] = " ";
        frames.push({ kind: "regex", inClass: false });
        return index + 1;
    }
    if (isQuote(char)) {
        out[index] = " ";
        frames.push({ kind: "literal", quote: char });
        return index + 1;
    }
    return null;
}

/** Consume one source character in code state. */
function stepCode(walk: Walk): number {
    return startConstruct(walk) ?? walk.index + 1;
}

/**
 * Consume one character of a literal, honouring escapes, its own quote and —
 * for a template — an interpolation opener, which pushes a frame instead of
 * ending the literal.
 */
function stepLiteral(walk: Walk, frame: LiteralFrame): number {
    const { content, out, index, frames } = walk;
    const char = content[index];
    if (char === "\\") {
        blankPair({ out, index });
        return index + 2;
    }
    if (frame.quote === "`" && char === "$" && content[index + 1] === "{") {
        blankPair({ out, index });
        frames.push({ kind: "interpolation", braces: 0 });
        return index + 2;
    }
    blank({ out, index });
    if (char === frame.quote) {
        frames.pop();
    }
    return index + 1;
}

/** Consume one character of a template interpolation. Its content is data, so
 * every character is blanked, but its structure is tracked: comments, strings,
 * regexes and nested templates push their own frames, `{` deepens the brace
 * count, and the unmatched `}` pops back to the enclosing template literal.
 */
function stepInterpolation(walk: Walk, frame: InterpolationFrame): number {
    const char = walk.content[walk.index] ?? "";
    if (char === "{" || char === "}") {
        return stepInterpolationBrace(walk, frame, char);
    }
    const stepped = startConstruct(walk);
    if (stepped !== null) {
        return stepped;
    }
    blank({ out: walk.out, index: walk.index });
    return walk.index + 1;
}

/** Consume one brace of a template interpolation. */
function stepInterpolationBrace(
    { out, index, frames }: Walk,
    frame: InterpolationFrame,
    char: string,
): number {
    blank({ out, index });
    if (char === "}") {
        if (frame.braces === 0) {
            frames.pop();
        } else {
            frames[frames.length - 1] = {
                kind: "interpolation",
                braces: frame.braces - 1,
            };
        }
        return index + 1;
    }
    frames[frames.length - 1] = {
        kind: "interpolation",
        braces: frame.braces + 1,
    };
    return index + 1;
}

/** Consume one character of a line comment, closing at the newline. */
function stepLineComment({ content, out, index, keep, frames }: Walk): number {
    if (content[index] === "\n") {
        frames.pop();
        return index + 1;
    }
    if (!keep) {
        blank({ out, index });
    }
    return index + 1;
}

/** Consume one character of a block comment, closing on the delimiter. */
function stepBlockComment({ content, out, index, keep, frames }: Walk): number {
    if (content[index] === "*" && content[index + 1] === "/") {
        if (!keep) {
            blankPair({ out, index });
        }
        frames.pop();
        return index + 2;
    }
    if (!keep) {
        blank({ out, index });
    }
    return index + 1;
}

/** Consume one character of a regex literal, closing on unescaped `/`. */
function stepRegex(walk: Walk, frame: RegexFrame): number {
    const { content, out, index, frames } = walk;
    const char = content[index];
    if (char === "\\") {
        blankPair({ out, index });
        return index + 2;
    }
    if (char === "\n") {
        // An unterminated pattern: the literal cannot span a line.
        frames.pop();
        return index + 1;
    }
    if (char === "[" && !frame.inClass) {
        blank({ out, index });
        frames[frames.length - 1] = { kind: "regex", inClass: true };
        return index + 1;
    }
    if (char === "]" && frame.inClass) {
        blank({ out, index });
        frames[frames.length - 1] = { kind: "regex", inClass: false };
        return index + 1;
    }
    blank({ out, index });
    if (char === "/" && !frame.inClass) {
        frames.pop();
    }
    return index + 1;
}

/** Consume the character at `index` in the innermost frame. */
function consume(walk: Walk): number {
    const frame = walk.frames.at(-1) ?? { kind: "code" };
    if (frame.kind === "line-comment") {
        return stepLineComment(walk);
    }
    if (frame.kind === "block-comment") {
        return stepBlockComment(walk);
    }
    if (frame.kind === "literal") {
        return stepLiteral(walk, frame);
    }
    if (frame.kind === "regex") {
        return stepRegex(walk, frame);
    }
    if (frame.kind === "interpolation") {
        return stepInterpolation(walk, frame);
    }
    return stepCode(walk);
}

/**
 * Blank strings and comments without changing the source's length or lines.
 *
 * @param content Raw test-source text.
 * @param options Masking options.
 * @param options.comments `"keep"` leaves comment text verbatim so rules can
 *   read phase labels from it; the default blanks it.
 * @returns The masked text, aligned with `content` offset for offset.
 */
export function maskTestSource(
    content: string,
    options: { readonly comments?: MaskComments } = {},
): string {
    const out = content.split("");
    const keep = options.comments === "keep";
    const frames: Frame[] = [{ kind: "code" }];
    let index = 0;
    while (index < content.length) {
        index = consume({ content, out, index, keep, frames });
    }
    return out.join("");
}
