// lib/test-review/mask.mts — offset-preserving masking for test source.
//
// Every test-hygiene rule reads masked source: a declaration, phase label or
// assertion quoted inside a string or comment is data, not test code. Masking
// blanks strings and comments with spaces, keeps every newline, and leaves all
// offsets aligned with the original content, so a regex match index still maps
// to the right line.
//
// Public surface:
//   maskTestSource(content) — the masked source, same length as the input
//
// A quote inside a comment never opens a literal: line and block comments are
// consumed before quotes are considered. An unterminated literal masks to the
// end of the source, matching the scanner's reading.

type Quote = '"' | "'" | "`";

type MaskMode = "code" | "line-comment" | "block-comment" | "literal";

interface MaskState {
    mode: MaskMode;
    quote: Quote | null;
}

interface Step {
    next: number;
    state: MaskState;
}

const CODE: MaskState = { mode: "code", quote: null };

/** Replace one character with a space unless it is the newline we preserve. */
function blank({ out, index }: { out: string[]; index: number }): void {
    if (out[index] !== "\n") {
        out[index] = " ";
    }
}

/** Enter a line comment, blanking both slashes. */
function startLineComment({
    out,
    index,
}: {
    out: string[];
    index: number;
}): Step {
    out[index] = " ";
    out[index + 1] = " ";
    return { next: index + 2, state: { mode: "line-comment", quote: null } };
}

/** Enter a block comment, blanking both delimiters. */
function startBlockComment({
    out,
    index,
}: {
    out: string[];
    index: number;
}): Step {
    out[index] = " ";
    out[index + 1] = " ";
    return { next: index + 2, state: { mode: "block-comment", quote: null } };
}

/** Enter a literal, blanking its opening quote. */
function startLiteral({
    out,
    index,
    quote,
}: {
    out: string[];
    index: number;
    quote: Quote;
}): Step {
    out[index] = " ";
    return { next: index + 1, state: { mode: "literal", quote } };
}

/** Consume one source character in code state. */
function stepCode({
    content,
    out,
    index,
}: {
    content: string;
    out: string[];
    index: number;
}): Step {
    const char = content[index];
    const next = content[index + 1];
    if (char === "/" && next === "/") {
        return startLineComment({ out, index });
    }
    if (char === "/" && next === "*") {
        return startBlockComment({ out, index });
    }
    if (char === '"' || char === "'" || char === "`") {
        return startLiteral({ out, index, quote: char });
    }
    return { next: index + 1, state: CODE };
}

/** Consume one character of a line comment. */
function stepLineComment({
    content,
    out,
    index,
}: {
    content: string;
    out: string[];
    index: number;
}): Step {
    if (content[index] === "\n") {
        return { next: index + 1, state: CODE };
    }
    blank({ out, index });
    return { next: index + 1, state: { mode: "line-comment", quote: null } };
}

/** Consume one character of a block comment, closing on the delimiter. */
function stepBlockComment({
    content,
    out,
    index,
}: {
    content: string;
    out: string[];
    index: number;
}): Step {
    if (content[index] === "*" && content[index + 1] === "/") {
        out[index] = " ";
        out[index + 1] = " ";
        return { next: index + 2, state: CODE };
    }
    blank({ out, index });
    return { next: index + 1, state: { mode: "block-comment", quote: null } };
}

/** Consume one character of a literal, honouring escapes and its own quote. */
function stepLiteral({
    content,
    out,
    index,
    quote,
}: {
    content: string;
    out: string[];
    index: number;
    quote: Quote;
}): Step {
    const char = content[index];
    if (char === "\\") {
        blank({ out, index });
        if (index + 1 < content.length) {
            blank({ out, index: index + 1 });
            return { next: index + 2, state: { mode: "literal", quote } };
        }
        return { next: index + 1, state: { mode: "literal", quote } };
    }
    if (char === quote) {
        out[index] = " ";
        return { next: index + 1, state: CODE };
    }
    blank({ out, index });
    return { next: index + 1, state: { mode: "literal", quote } };
}

/** Consume the character at `index` in the current state. */
function consume({
    content,
    out,
    index,
    state,
}: {
    content: string;
    out: string[];
    index: number;
    state: MaskState;
}): Step {
    if (state.mode === "line-comment") {
        return stepLineComment({ content, out, index });
    }
    if (state.mode === "block-comment") {
        return stepBlockComment({ content, out, index });
    }
    if (state.mode === "literal") {
        return stepLiteral({
            content,
            out,
            index,
            quote: state.quote ?? '"',
        });
    }
    return stepCode({ content, out, index });
}

/**
 * Blank strings and comments without changing the source's length or lines.
 *
 * @param content Raw test-source text.
 * @returns The masked text, aligned with `content` offset for offset.
 */
export function maskTestSource(content: string): string {
    const out = content.split("");
    let state: MaskState = CODE;
    let index = 0;
    while (index < content.length) {
        const step = consume({ content, out, index, state });
        state = step.state;
        index = step.next;
    }
    return out.join("");
}
