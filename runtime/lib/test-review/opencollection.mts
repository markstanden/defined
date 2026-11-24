// lib/test-review/opencollection.mts — OpenCollection (Bruno) request and
// environment readers.
//
// Line-oriented on purpose: only the sections the always-on rules need are
// read — `info.name`, a literal `http.url`, a literal credential inside
// `http.auth`, whether `runtime` declares an assertion or a tests script, and
// the variables of an environment file. Everything else is the reviewer's.
//
// Public surface:
//   readCollectionRequest({ path, content }) — the request, or `null` when the
//     file is not an OpenCollection request
//   readEnvironmentVariables(content) — the variables in an environment file
//   isEnvironmentPath(path) — whether a path is an `environments/*.ya?ml`
//
// Deliberate ceiling (ponytail): lexical, not a YAML parser. Auth written
// inline (`auth: { token: x }`), credentials outside `http.auth`, inherited
// collection auth and non-http request blocks are not read; the mask is never
// involved because YAML values are data, not code.

import { basename } from "node:path";

/** A line of a request the rules point at: 1-based line and its text. */
export interface CollectionLine {
    /** 1-based line number. */
    readonly line: number;
    /** The line as written, trimmed. */
    readonly text: string;
}

/** The parts of an OpenCollection request the rules read. */
export interface CollectionRequest {
    /** `info.name`, or the file name when the request names none. */
    readonly name: string;
    /** Whether `runtime.assertions` declares at least one row. */
    readonly hasAssertions: boolean;
    /** Whether a `type: tests` script carries a non-blank code block. */
    readonly hasTestsScript: boolean;
    /** The literal url line, when the url names a scheme and host. */
    readonly url: CollectionLine | null;
    /** The literal credential line, when `http.auth` holds one. */
    readonly credential: CollectionLine | null;
}

/** One variable entry from an OpenCollection environment file. */
export interface EnvironmentVariable {
    /** The variable name. */
    readonly name: string;
    /** The literal value, or an empty string when the entry has none. */
    readonly value: string;
    /** Whether the entry is marked `secret: true`. */
    readonly secret: boolean;
    /** 1-based line of the entry. */
    readonly line: number;
}

/** The sections the reader follows and the fields it fills as it goes. */
interface RequestDraft {
    section: string;
    name: string;
    hasAssertions: boolean;
    hasTestsScript: boolean;
    url: CollectionLine | null;
    credential: CollectionLine | null;
    authIndent: number | null;
}

/** A top-level YAML section heading. */
const TOP_SECTION = /^([A-Za-z]\w*):[ \t]*$/u;

/** The credential keys an auth block can hold. */
const CREDENTIAL_KEY =
    /^[ \t]+(token|password|apiKey|api_key|clientSecret):[ \t]*(\S.*)$/u;

/** The unquoted value of a YAML scalar. */
function yamlValue(raw: string): string {
    return raw.trim().replace(/^["']/u, "").replace(/["']$/u, "");
}

/** Whether a file's content is an OpenCollection http request. */
function isRequest(content: string): boolean {
    return (
        /^info:[ \t]*$/mu.test(content) &&
        /^http:[ \t]*$/mu.test(content) &&
        /^[ \t]+type:[ \t]*http\b/mu.test(content)
    );
}

/** Leading whitespace length of a line. */
function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

/** Whether the `code:` block below its header line holds any text. */
function codeBlockHasText(
    lines: readonly string[],
    header: number,
    indent: number,
): boolean {
    for (let index = header + 1; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (line.trim() === "") {
            continue;
        }
        return indentOf(line) > indent;
    }
    return false;
}

/** Whether a `type: tests` entry at `from` carries non-blank code. */
function scriptHasCode(lines: readonly string[], from: number): boolean {
    for (let index = from + 1; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (/^[ \t]*-[ \t]+\w+:/u.test(line)) {
            return false;
        }
        const header = /^([ \t]+)code:[ \t]*\|-?[ \t]*$/u.exec(line);
        if (header !== null) {
            return codeBlockHasText(lines, index, (header[1] ?? "").length);
        }
    }
    return false;
}

/** Read the `name` field of the `info` section. */
function readInfoLine(line: string, draft: RequestDraft): void {
    const field = /^[ \t]+name:[ \t]*(\S.*)$/u.exec(line);
    if (field !== null) {
        draft.name = yamlValue(field[1] ?? "");
    }
}

/** Track where the `auth:` block starts and ends. */
function trackAuthBlock(line: string, draft: RequestDraft): void {
    const indent = indentOf(line);
    if (
        draft.authIndent !== null &&
        line.trim() !== "" &&
        indent <= draft.authIndent
    ) {
        draft.authIndent = null;
    }
    if (/^[ \t]+auth:[ \t]*$/u.test(line)) {
        draft.authIndent = indent;
    }
}

/** Read a literal url line. */
function readUrlLine(line: string, index: number, draft: RequestDraft): void {
    const urlField = /^[ \t]+url:[ \t]*(\S.*)$/u.exec(line);
    const value = yamlValue(urlField?.[1] ?? "");
    // A templated authority (`https://{{host}}/...`) is not a literal host.
    if (urlField !== null && /^https?:\/\/(?!\{\{)/u.test(value)) {
        draft.url = { line: index + 1, text: line.trim() };
    }
}

/** Read a literal credential line inside the auth block. */
function readCredentialLine(
    line: string,
    index: number,
    draft: RequestDraft,
): void {
    if (draft.authIndent === null) {
        return;
    }
    const found = CREDENTIAL_KEY.exec(line);
    const value = yamlValue(found?.[2] ?? "");
    if (found !== null && value !== "" && !value.startsWith("{{")) {
        draft.credential = {
            line: index + 1,
            text: `${found[1]}: <literal>`,
        };
    }
}

/** Read one line of the `http` section: url and auth credential. */
function readHttpLine(line: string, index: number, draft: RequestDraft): void {
    trackAuthBlock(line, draft);
    readUrlLine(line, index, draft);
    readCredentialLine(line, index, draft);
}

/** Read one line of the `runtime` section: assertions and tests scripts. */
function readRuntimeLine(
    lines: readonly string[],
    line: string,
    index: number,
    draft: RequestDraft,
): void {
    if (/^[ \t]+-[ \t]+expression:/u.test(line)) {
        draft.hasAssertions = true;
    }
    const script = /^[ \t]+-[ \t]+type:[ \t]*(\S.*)$/u.exec(line);
    if (
        script !== null &&
        yamlValue(script[1] ?? "") === "tests" &&
        scriptHasCode(lines, index)
    ) {
        draft.hasTestsScript = true;
    }
}

/**
 * Read the parts of one OpenCollection request.
 *
 * @param root0 the parameter object
 * @param root0.path Repo-relative path, for the name fallback.
 * @param root0.content Full contents of the file.
 * @returns The request, or `null` when the content is not an http request.
 */
export function readCollectionRequest({
    path,
    content,
}: {
    readonly path: string;
    readonly content: string;
}): CollectionRequest | null {
    if (!isRequest(content)) {
        return null;
    }
    const lines = content.split("\n");
    const draft: RequestDraft = {
        section: "",
        name: "",
        hasAssertions: false,
        hasTestsScript: false,
        url: null,
        credential: null,
        authIndent: null,
    };

    lines.forEach((line, index) => {
        const top = TOP_SECTION.exec(line);
        if (top !== null) {
            draft.section = top[1] ?? "";
            draft.authIndent = null;
            return;
        }
        if (draft.section === "info") {
            readInfoLine(line, draft);
        } else if (draft.section === "http") {
            readHttpLine(line, index, draft);
        } else if (draft.section === "runtime") {
            readRuntimeLine(lines, line, index, draft);
        }
    });

    return {
        name: draft.name === "" ? basename(path) : draft.name,
        hasAssertions: draft.hasAssertions,
        hasTestsScript: draft.hasTestsScript,
        url: draft.url,
        credential: draft.credential,
    };
}

/** Whether a path is an OpenCollection environment file. */
export function isEnvironmentPath(path: string): boolean {
    return /(?:^|\/)environments\//u.test(path) && /\.ya?ml$/u.test(path);
}

/** The variables declared in an OpenCollection environment file. */
export function readEnvironmentVariables(
    content: string,
): EnvironmentVariable[] {
    const entries: EnvironmentVariable[] = [];
    let current: EnvironmentVariable | null = null;

    const apply = (key: string, raw: string): void => {
        if (current === null) {
            return;
        }
        const value = yamlValue(raw);
        if (key === "name") {
            current = { ...current, name: value };
        } else if (key === "value") {
            current = { ...current, value };
        } else if (key === "secret") {
            current = { ...current, secret: value === "true" };
        }
    };

    content.split("\n").forEach((line, index) => {
        const item = /^[ \t]*-[ \t]+(\w+):[ \t]*(\S.*)?$/u.exec(line);
        if (item !== null) {
            if (current !== null) {
                entries.push(current);
            }
            current = { name: "", value: "", secret: false, line: index + 1 };
            apply(item[1] ?? "", item[2] ?? "");
            return;
        }
        const field = /^[ \t]+(\w+):[ \t]*(\S.*)?$/u.exec(line);
        if (field !== null) {
            apply(field[1] ?? "", field[2] ?? "");
        }
    });
    if (current !== null) {
        entries.push(current);
    }
    return entries;
}
