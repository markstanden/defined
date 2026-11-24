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
// Deliberate ceiling (ponytail): a text scanner, not a parser. A quote inside a
// regex literal opens a literal, and the code inside a template interpolation is
// masked as data, so either can blank real code. mask.test.mts pins both as
// documented ceilings; upgrade to token-aware parsing only if the blind spots
// ever earn the dependency.

type Quote = '"' | "'" | "`";

/** Whether comment text is blanked (`blank`) or kept (`keep`). */
export type MaskComments = "blank" | "keep";

type MaskMode = "code" | "line-comment" | "block-comment" | "literal";

interface MaskState {
    mode: MaskMode;
    quote: Quote | null;
}

interface Step {
    next: number;
    state: MaskState;
}

interface Walk {
    content: string;
    out: string[];
    index: number;
    /** Keep comment text verbatim for rules that read labels from comments. */
    keep: boolean;
}

const CODE: MaskState = { mode: "code", quote: null };

/** Replace one character with a space unless it is the newline we preserve. */
function blank({ out, index }: { out: string[]; index: number }): void {
    if (out[index] !== "\n") {
        out[index] = " ";
    }
}

/** Enter a line comment, blanking both slashes unless comments are kept. */
function startLineComment({ out, index, keep }: Walk): Step {
    if (!keep) {
        out[index] = " ";
        out[index + 1] = " ";
    }
    return { next: index + 2, state: { mode: "line-comment", quote: null } };
}

/** Enter a block comment, blanking both delimiters unless comments are kept. */
function startBlockComment({ out, index, keep }: Walk): Step {
    if (!keep) {
        out[index] = " ";
        out[index + 1] = " ";
    }
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
function stepCode({ content, out, index, keep }: Walk): Step {
    const char = content[index];
    const next = content[index + 1];
    if (char === "/" && next === "/") {
        return startLineComment({ content, out, index, keep });
    }
    if (char === "/" && next === "*") {
        return startBlockComment({ content, out, index, keep });
    }
    if (char === '"' || char === "'" || char === "`") {
        return startLiteral({ out, index, quote: char });
    }
    return { next: index + 1, state: CODE };
}

/** Consume one character of a line comment. */
function stepLineComment({ content, out, index, keep }: Walk): Step {
    if (content[index] === "\n") {
        return { next: index + 1, state: CODE };
    }
    if (!keep) {
        blank({ out, index });
    }
    return { next: index + 1, state: { mode: "line-comment", quote: null } };
}

/** Consume one character of a block comment, closing on the delimiter. */
function stepBlockComment({ content, out, index, keep }: Walk): Step {
    if (content[index] === "*" && content[index + 1] === "/") {
        if (!keep) {
            out[index] = " ";
            out[index + 1] = " ";
        }
        return { next: index + 2, state: CODE };
    }
    if (!keep) {
        blank({ out, index });
    }
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
    keep,
    state,
}: Walk & { state: MaskState }): Step {
    if (state.mode === "line-comment") {
        return stepLineComment({ content, out, index, keep });
    }
    if (state.mode === "block-comment") {
        return stepBlockComment({ content, out, index, keep });
    }
    if (state.mode === "literal") {
        return stepLiteral({
            content,
            out,
            index,
            quote: state.quote ?? '"',
        });
    }
    return stepCode({ content, out, index, keep });
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
    let state: MaskState = CODE;
    let index = 0;
    while (index < content.length) {
        const step = consume({ content, out, index, keep, state });
        state = step.state;
        index = step.next;
    }
    return out.join("");
}
