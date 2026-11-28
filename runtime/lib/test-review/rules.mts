// lib/test-review/rules.mts — the test-hygiene rule engine.
//
// Rules read masked source (lib/test-review/mask.mts) and report findings in
// the gate's diagnostic vocabulary: rule id, repo-relative file, 1-based line
// and an actionable message. A finding names the rule, never a verdict about
// the reviewer's judgement.
//
// Public surface:
//   reviewTestSources(sources, { review }) — findings for the named sources;
//     `review: true` adds the review-tier leads (`scan --files` only)
//   ALWAYS_ON_RULES — the always-on defect ids every surface reports
//   REVIEW_RULES — the review-tier lead ids a named-file pass also reports
//   LEAD_RULES — the Bucket C intent leads the gate never owns
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
// Review tier (`scan --files` only): the determinism family reads ambient
// state and real I/O in a declaration's masked body — clock, sleep, random,
// environment, locale, network, filesystem, process spawn, debug output. The
// structure pair reads phase labels out of the body's comments (`Arrange`,
// `Act`, `Assert`, combined with a joiner): `missing-structure` when act and
// assert are not both labelled, `multi-statement-act` when the act region
// holds more than one depth-0 statement. Labels are read from the raw body
// with strings blanked, never from the masked body, which has no comments.
// The assertion-shape quartet reads the masked body's blocks with
// bracket-matched spans: an assertion inside an `if` guard or block
// (`conditional-assertion`), a loop or `.forEach` callback
// (`assertion-in-loop`), an asserting `else` (`else-branch-assertion`), and a
// boolean assertion joining two conditions with `&&` or `||`
// (`compound-assertion`). An else-if chain fires both conditional and
// else-branch rules, as the scanner does.
//
// A review lead is suppressed by a why-note in the contiguous comment block
// above its declaration (`lib/test-review/suppression.mts` owns the grammar):
// `Why use <rule-id> here: <reason>`. A note naming an unknown or wrong-case
// id, an always-on defect, or giving a vacuous reason is itself a finding
// (`suppression-note`) and suppresses nothing; a note naming an intent lead is
// accepted and inert. Notes are read in review mode only, so `verify` and
// `comply` never see one and an always-on defect has no escape.
//
// `literal-tautology` reads each declaration's masked body: a comparison of a
// literal with itself, or an expression with itself, cannot fail for any input.
// `commented-out-assertion` reads the raw body lines: an assertion left in a
// comment never runs, so nothing is checked at that point. The oracle's rules
// for other stacks (PHPUnit, Python) land with those declaration layers.
//
// `unrouted-property-seed` (review tier) reads a property test's seed, which
// freezes the run when it is a literal. It reports a numeric `seed:` literal in
// an `fc.assert` options object — an identifier or call is not a literal — a
// C# `Replay = "<literal>"` with no `$` interpolation, which freezes and never
// rotates, and a C# replay whose gamma is even, which FsCheck rejects by
// crashing the test host; that branch is highest-value and reported once, ahead
// of the frozen-replay wording. The C# replay usually sits in an attribute above
// its declaration, so a why-note goes above that line; a fast-check seed takes
// the ordinary note above its declaration. A finding outside any declaration's
// body (an attribute or a constructor replay) reads the note block above its own
// line, which is why the replay sites are covered at all. Interpolation is not
// judged when the gamma is a runtime expression, but a literal tail is. A
// `Replay = Pin` (or `SomeType.Pin`) is followed to a same-file `const
// string`/`static readonly string` literal; an identifier the file does not
// define is left alone.
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
// `Expect(`, and Shouldly's generic forms (`ShouldThrow<…>`). FsCheck's
// `Check.One(` counts too: a replay throws when the law fails. The oracle
// misses the last three and so reports five false positives across the C#
// corpus. A
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
    commentBlockAbove,
    isVacuous,
    readNote,
    resolveRule,
} from "./suppression.mts";
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

/** The review-tier lead ids `scan --files` reports and a note can suppress. */
export const REVIEW_RULES = [
    "missing-structure",
    "multi-statement-act",
    "compound-assertion",
    "conditional-assertion",
    "assertion-in-loop",
    "else-branch-assertion",
    "suppression-note",
    "ambient-clock",
    "sleep",
    "randomness",
    "ambient-environment",
    "ambient-locale",
    "real-network",
    "real-filesystem",
    "process-spawn",
    "debug-output",
    "unrouted-property-seed",
] as const;

/** The Bucket C intent leads the gate reports and never owns. */
export const LEAD_RULES = [
    "identical-body-shape",
    "single-row-parameterised",
    "literal-expectation",
    "computed-expectation",
    "computed-title",
    "property-trigger-unmet",
    "single-line-summary",
    "status-only-tests",
    "legacy-bru-present",
] as const;

/** One always-on test-hygiene rule id. */
export type AlwaysOnRule = (typeof ALWAYS_ON_RULES)[number];

/** One review-tier lead id. */
export type ReviewRule = (typeof REVIEW_RULES)[number];

/** One Bucket C intent lead id. */
export type LeadRule = (typeof LEAD_RULES)[number];

/** Any rule id the engine knows. */
export type TestHygieneRule = AlwaysOnRule | ReviewRule | LeadRule;

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

/** One declaration with the review rules its why-notes suppress. */
interface ReviewedDeclaration {
    readonly declaration: TestDeclaration;
    readonly suppressed: ReadonlySet<string>;
}

/** Tier membership as exact-case sets, so a wrong-case id is not a rule. */
const ALWAYS_ON_IDS: ReadonlySet<string> = new Set(ALWAYS_ON_RULES);
const REVIEW_IDS: ReadonlySet<string> = new Set(REVIEW_RULES);
const LEAD_IDS: ReadonlySet<string> = new Set(LEAD_RULES);

/** One suppression-note fault at the note's line. */
function noteFault({
    file,
    line,
    message,
}: {
    file: string;
    line: number;
    message: string;
}): TestHygieneFinding {
    return { rule: "suppression-note", file, line, message };
}

/**
 * The notes above one declaration, split into the rules they suppress and the
 * faults they carry. A note naming an always-on defect, an unknown id or a
 * vacuous reason suppresses nothing and reports at its own line; a note naming
 * a review id suppresses that rule for this declaration; a note naming an
 * intent lead is accepted and inert.
 */
function readSuppressions({
    file,
    content,
    line,
}: {
    file: string;
    content: string;
    line: number;
}): { suppressed: ReadonlySet<string>; faults: TestHygieneFinding[] } {
    const suppressed = new Set<string>();
    const faults: TestHygieneFinding[] = [];
    for (const entry of commentBlockAbove({ content, line })) {
        const note = readNote(entry.text);
        if (note === null) {
            continue;
        }
        const rule = resolveRule(note.rule);
        if (ALWAYS_ON_IDS.has(rule)) {
            faults.push(
                noteFault({
                    file,
                    line: entry.line,
                    message: `suppression note for "${note.rule}" tries to suppress an always-on defect: always-on defects have no escape`,
                }),
            );
            continue;
        }
        if (!REVIEW_IDS.has(rule) && !LEAD_IDS.has(rule)) {
            faults.push(
                noteFault({
                    file,
                    line: entry.line,
                    message: `suppression note names unknown rule id "${note.rule}": the note suppresses nothing`,
                }),
            );
            continue;
        }
        if (isVacuous(note.reason)) {
            faults.push(
                noteFault({
                    file,
                    line: entry.line,
                    message: `suppression note for "${note.rule}" gives no reason: state how the construct is controlled or why the rule does not apply`,
                }),
            );
            continue;
        }
        if (REVIEW_IDS.has(rule)) {
            suppressed.add(rule);
        }
    }
    return { suppressed, faults };
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

/**
 * A ticket reference that parks a skip beside a declaration.
 *
 * ponytail: a word-token match, so an encoding name like `UTF-8` in a comment
 * also parks a skip — a false negative in a heuristic, accepted.
 */
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
    const own = content.split("\n")[line - 1] ?? "";
    const block = commentBlockAbove({ content, line }).map(
        (entry) => entry.text,
    );
    return TICKET.test([own, ...block].join("\n"));
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
 * Ambient state and real I/O visible in a declaration's masked body. Each
 * pattern is the scanner's, ported verbatim so parity is measurable; the
 * consequence is the doctrine's wording, not a verdict.
 */
const DETERMINISM_RULES: ReadonlyArray<{
    readonly rule: ReviewRule;
    readonly pattern: RegExp;
    readonly subject: string;
    readonly consequence: string;
}> = [
    {
        rule: "ambient-clock",
        pattern: /\bDateTime(?:Offset)?\.(?:Now|UtcNow|Today)\b/g,
        subject: "ambient clock read",
        consequence: "the result depends on when the test ran",
    },
    {
        rule: "ambient-clock",
        pattern: /\bInstant\.now\s*\(|\bLocalDate(?:Time)?\.now\s*\(/g,
        subject: "ambient clock read",
        consequence: "the result depends on when the test ran",
    },
    {
        rule: "ambient-clock",
        pattern: /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)/g,
        subject: "ambient clock read",
        consequence: "the result depends on when the test ran",
    },
    {
        rule: "ambient-clock",
        pattern: /\b(?:time\.Now|time\.time|datetime\.(?:now|utcnow))\s*\(/g,
        subject: "ambient clock read",
        consequence: "the result depends on when the test ran",
    },
    {
        rule: "sleep",
        pattern: /\b(?:Thread\.Sleep|Task\.Delay|time\.Sleep|sleep)\s*\(/g,
        subject: "sleep or delay",
        consequence: "the test races the clock instead of controlling it",
    },
    {
        rule: "randomness",
        pattern: /\b(?:Math\.random|Random\(|rand\.|mt_rand\(|rand\()/g,
        subject: "random value",
        consequence: "the input is not reproducible",
    },
    {
        rule: "randomness",
        pattern: /\bGuid\.NewGuid\b|\bUUID\.randomUUID\s*\(/g,
        subject: "random identifier",
        consequence: "the input is not reproducible",
    },
    {
        rule: "ambient-environment",
        pattern:
            /\b(?:Environment\.(?:GetEnvironmentVariable|CurrentDirectory|MachineName)|process\.env|os\.environ|os\.Getenv|getenv\()/g,
        subject: "ambient environment read",
        consequence: "the result depends on the host",
    },
    {
        rule: "ambient-locale",
        pattern:
            /\b(?:CultureInfo\.(?:CurrentCulture|CurrentUICulture)|Locale\.getDefault)\b/g,
        subject: "ambient locale read",
        consequence: "the result depends on the machine's locale",
    },
    {
        rule: "real-network",
        pattern:
            /\b(?:HttpClient|axios|requests\.|http\.Get|net\.Dial)\b|\bfetch\s*\(/g,
        subject: "real network client",
        consequence: "the test needs a reachable peer",
    },
    {
        rule: "real-filesystem",
        pattern:
            /\b(?:File|Directory)\.\w+\s*\(|\bPath\.GetTemp(?:Path|FileName)\b|\bfs\.\w+\s*\(|\btempfile\.\w+\s*\(/g,
        subject: "real filesystem access",
        consequence: "the test needs a writable host",
    },
    {
        rule: "process-spawn",
        pattern:
            /\bProcess\.Start\b|\b(?:execFile|execSync|spawn|spawnSync|fork)\s*\(|\bsubprocess\.\w+/g,
        subject: "child process spawn",
        consequence: "the test needs the host's binaries",
    },
    {
        rule: "debug-output",
        pattern:
            /\bConsole\.(?:Write|WriteLine|Error)\b|\bDebug\.Write(?:Line)?\b|\bconsole\.(?:log|debug|warn)\b/g,
        subject: "debug output",
        consequence: "console output left in a test",
    },
];

/** Determinism leads in one source's declarations, in body order. */
function determinismFindings({
    source,
    entries,
}: {
    source: TestReviewSource;
    entries: readonly ReviewedDeclaration[];
}): TestHygieneFinding[] {
    return entries.flatMap(
        ({ declaration, suppressed }): TestHygieneFinding[] => {
            const body = declaration.maskedBody;
            if (body === null) {
                return [];
            }
            const raw = declaration.body ?? body;
            return DETERMINISM_RULES.flatMap((rule): TestHygieneFinding[] =>
                suppressed.has(rule.rule)
                    ? []
                    : [...body.matchAll(rule.pattern)].map((match) => ({
                          rule: rule.rule,
                          file: source.path,
                          line: lineInBody({
                              body,
                              bodyLine: declaration.bodyLine,
                              index: match.index ?? 0,
                          }),
                          message: `${rule.subject} in test "${declaration.name}": "${collapse(raw.slice(match.index ?? 0, (match.index ?? 0) + match[0].length))}" — ${rule.consequence}`,
                      })),
            );
        },
    );
}

/** A fast-check property assertion, whose options can pin a seed. */
const FAST_CHECK_ASSERT = /\bfc\.assert\s*\(/gu;

/** A literal seed inside a fast-check options object. */
const FAST_CHECK_SEED = /\bseed\s*:\s*\d[\d_]*/gu;

/** A C# Replay assignment; its raw value decides literal versus interpolated. */
const REPLAY_ASSIGNMENT = /\bReplay\s*=/gu;

/** One property seed the rule reports. */
interface PropertySeedMatch {
    /** Offset of the seed, replay value or assignment in the masked source. */
    readonly index: number;
    readonly kind: "seed" | "frozen-replay" | "even-gamma";
    /** The matched text as written. */
    readonly evidence: string;
    /** The even gamma, when the match is a gamma fault. */
    readonly gamma?: string;
}

/** Bracket characters that nest inside a call's argument list. */
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/**
 * The comma-separated argument slices of a call body, with their offsets.
 * Bracket depth keeps a nested call's commas inside one slice.
 */
function argumentSlices(
    text: string,
): Array<{ readonly start: number; readonly text: string }> {
    const slices: Array<{ start: number; text: string }> = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        const character = text[index] ?? "";
        if (OPENERS.has(character)) {
            depth++;
        } else if (CLOSERS.has(character)) {
            depth = Math.max(0, depth - 1);
        } else if (character === "," && depth === 0) {
            slices.push({ start, text: text.slice(start, index) });
            start = index + 1;
        }
    }
    slices.push({ start, text: text.slice(start) });
    return slices;
}

/**
 * Literal seeds on `fc.assert` options arguments. Only an object-literal
 * argument is read, so a `seed:` key elsewhere in the property never fires.
 */
function fastCheckSeedMatches({
    masked,
    raw,
}: {
    masked: string;
    raw: string;
}): PropertySeedMatch[] {
    return [...masked.matchAll(FAST_CHECK_ASSERT)].flatMap((call) => {
        const open = (call.index ?? 0) + call[0].length - 1;
        const close = matchingClose(masked, open);
        const args = masked.slice(open + 1, close);
        return argumentSlices(args).flatMap((argument) => {
            if (!argument.text.trim().startsWith("{")) {
                return [];
            }
            return [...argument.text.matchAll(FAST_CHECK_SEED)].map((seed) => {
                const index = open + 1 + argument.start + (seed.index ?? 0);
                return {
                    index,
                    kind: "seed" as const,
                    evidence: raw.slice(index, index + seed[0].length),
                };
            });
        });
    });
}

/** One raw C# Replay value: interpolation and text, or `null` when not literal. */
interface ReplayValue {
    readonly interpolated: boolean;
    readonly value: string;
}

/** Index of the first non-whitespace character at or after `from`. */
function skipSpaces({ raw, from }: { raw: string; from: number }): number {
    let index = from;
    while (index < raw.length && /\s/u.test(raw[index] ?? "")) {
        index++;
    }
    return index;
}

/** The quote after any `$`/`@` prefixes, and whether `$` appeared. */
function replayQuote({
    raw,
    from,
}: {
    raw: string;
    from: number;
}): { readonly interpolated: boolean; readonly quote: number } | null {
    let index = skipSpaces({ raw, from });
    let interpolated = false;
    while (raw[index] === "$" || raw[index] === "@") {
        interpolated = interpolated || raw[index] === "$";
        index++;
    }
    return raw[index] === '"' ? { interpolated, quote: index } : null;
}

/** Index of the closing quote of the literal opened at `quote`, or `-1`. */
function closingQuote({ raw, quote }: { raw: string; quote: number }): number {
    let index = quote + 1;
    while (index < raw.length && raw[index] !== '"' && raw[index] !== "\n") {
        index += raw[index] === "\\" ? 2 : 1;
    }
    return raw[index] === '"' ? index : -1;
}

/** Read the quoted value assigned at `from`, looking past `$`/`@` prefixes. */
function replayValue({
    raw,
    from,
}: {
    raw: string;
    from: number;
}): ReplayValue | null {
    const opening = replayQuote({ raw, from });
    if (opening === null) {
        return null;
    }
    const close = closingQuote({ raw, quote: opening.quote });
    if (close === -1) {
        return null;
    }
    return {
        interpolated: opening.interpolated,
        value: raw.slice(opening.quote + 1, close),
    };
}

/** The numeric gamma after the last comma, when the replay carries one. */
function replayGamma(value: string): string | null {
    const comma = value.lastIndexOf(",");
    if (comma === -1) {
        return null;
    }
    const gamma = value.slice(comma + 1).trim();
    return /^\d+$/u.test(gamma) ? gamma : null;
}

/** A C# replay seed constant: `const string` or `static readonly string`. */
const REPLAY_CONSTANT =
    /\b(?:const|static\s+readonly)\s+string\s+([A-Za-z_]\w*)\s*=/gu;

/** An identifier chain naming a same-file constant. */
const REPLAY_IDENTIFIER = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/u;

/** What may follow a resolved identifier in its expression. */
const EXPRESSION_END = /^[;,)\]}]*$/u;

/**
 * Same-file replay constants by name. A `const string`/`static readonly string`
 * counts only when its initialiser is a literal tuple (never an interpolated
 * string, which a `const` cannot be). A name declared twice with different
 * values is ambiguous and resolves to nothing.
 */
function replayConstants({
    masked,
    raw,
}: {
    masked: string;
    raw: string;
}): Map<string, ReplayValue | null> {
    const constants = new Map<string, ReplayValue | null>();
    for (const match of masked.matchAll(REPLAY_CONSTANT)) {
        const name = match[1] ?? "";
        const value = replayValue({
            raw,
            from: (match.index ?? 0) + match[0].length,
        });
        const literal = value !== null && !value.interpolated ? value : null;
        if (!constants.has(name)) {
            constants.set(name, literal);
            continue;
        }
        if (constants.get(name)?.value !== literal?.value) {
            constants.set(name, null);
        }
    }
    return constants;
}

/**
 * Resolve a `Replay = Pin` or `Replay = SomeType.Pin` identifier against the
 * same-file constants, or `null` when the file does not define it or the
 * expression continues past a bare name (a call, member access, indexer).
 *
 * ponytail: the final chain segment is matched by name, so `SomeType.Pin` is
 * not scoped to its type. Cross-file and imported symbols are never resolved;
 * the gate reads one file at a time. Upgrade to a symbol table if a same-name
 * collision ever turns up.
 */
function replayIdentifier({
    raw,
    from,
    constants,
}: {
    raw: string;
    from: number;
    constants: ReadonlyMap<string, ReplayValue | null>;
}): ReplayValue | null {
    const start = skipSpaces({ raw, from });
    const chain = REPLAY_IDENTIFIER.exec(raw.slice(start))?.[0];
    if (chain === undefined) {
        return null;
    }
    const end = skipSpaces({ raw, from: start + chain.length });
    if (!EXPRESSION_END.test(raw[end] ?? "")) {
        return null;
    }
    const name = chain.slice(chain.lastIndexOf(".") + 1);
    return constants.get(name) ?? null;
}

/** The finding shape for one replay value, or `[]` when it cannot be judged. */
function replayValueMatches({
    index,
    replay,
}: {
    index: number;
    replay: ReplayValue;
}): PropertySeedMatch[] {
    const gamma = replayGamma(replay.value);
    if (gamma !== null && /[02468]$/u.test(gamma)) {
        return [
            {
                index,
                kind: "even-gamma" as const,
                evidence: replay.value,
                gamma,
            },
        ];
    }
    if (replay.interpolated) {
        return [];
    }
    return [
        {
            index,
            kind: "frozen-replay" as const,
            evidence: replay.value,
        },
    ];
}

/**
 * C# Replay values that freeze the run: a literal replay that never rotates,
 * and an even gamma, which FsCheck rejects by crashing the test host. The gamma
 * branch is read first, so an even literal reports once. An interpolated replay
 * is judged only when its gamma is a literal tail. An identifier is followed to
 * a same-file literal constant, or left alone.
 */
function replayMatches({
    masked,
    raw,
}: {
    masked: string;
    raw: string;
}): PropertySeedMatch[] {
    const constants = replayConstants({ masked, raw });
    return [...masked.matchAll(REPLAY_ASSIGNMENT)].flatMap((match) => {
        const index = match.index ?? 0;
        const from = index + match[0].length;
        const replay =
            replayValue({ raw, from }) ??
            replayIdentifier({ raw, from, constants });
        return replay === null ? [] : replayValueMatches({ index, replay });
    });
}

/** Whether a declaration's body covers a 1-based line. */
function bodyCovers(declaration: TestDeclaration, line: number): boolean {
    return (
        declaration.body !== null &&
        line >= declaration.bodyLine &&
        line < declaration.bodyLine + declaration.body.split("\n").length
    );
}

/** One message for a property-seed match, in the gate's vocabulary. */
function propertySeedMessage(
    match: PropertySeedMatch,
    testName: string | null,
): string {
    if (match.kind === "seed") {
        const test = testName === null ? "" : ` in test "${testName}"`;
        return `literal fast-check seed "${match.evidence}"${test}: a pinned seed freezes the run; replay the printed seed locally and promote the counterexample`;
    }
    if (match.kind === "even-gamma") {
        return `FsCheck replay "${match.evidence}" has an even gamma (${match.gamma}): FsCheck requires an odd gamma and crashes the test host`;
    }
    return `frozen FsCheck replay "${match.evidence}": a pinned replay never rotates; record the failing seed in the per-class ledger instead`;
}

/**
 * Property seeds that freeze the run. The seed lives in a test body for
 * fast-check but in an attribute above the declaration for FsCheck, so a finding
 * is suppressed by a note above its declaration or above the finding's own
 * line. Review tier only.
 */
function propertySeedFindings({
    source,
    masked,
    entries,
}: {
    source: TestReviewSource;
    masked: string;
    entries: readonly ReviewedDeclaration[];
}): TestHygieneFinding[] {
    const rule: ReviewRule = "unrouted-property-seed";
    const raw = source.content;
    const matches = [
        ...(source.path.endsWith(".cs")
            ? []
            : fastCheckSeedMatches({ masked, raw })),
        ...(source.path.endsWith(".cs") ? replayMatches({ masked, raw }) : []),
    ];
    return matches.flatMap((match): TestHygieneFinding[] => {
        const line = lineAt({ content: raw, index: match.index });
        const owner = entries.find(({ declaration }) =>
            bodyCovers(declaration, line),
        );
        const suppressed =
            owner?.suppressed.has(rule) === true ||
            readSuppressions({
                file: source.path,
                content: raw,
                line,
            }).suppressed.has(rule);
        if (suppressed) {
            return [];
        }
        return [
            {
                rule,
                file: source.path,
                line,
                message: propertySeedMessage(
                    match,
                    owner?.declaration.name ?? null,
                ),
            },
        ];
    });
}

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
    /\b\w*Assert\.\w+\s*\(/u,
    /\b(?:Assert|Verify|Expect)(?:[A-Z]\w*)?\s*[(<]/u,
    /\.Should\s*\(/u,
    /\bAnd\.\w+\s*\(/u,
    /\bShould(?:Be|Not|Have|Contain|Match|Start|End|Equal|Satisfy|Throw)\w*\s*[(<]/u,
    /\bShould\.(?:Throw|NotThrow|CompleteIn)\w*\s*[(<]/u,
    /\bCheck\.(?:One|All|Method|Quick)\s*[(<]/u,
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
    /\b(?:Assert|assert|expect|should|verify)(?:\.\w+\s*\(|\()/;

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

/**
 * Moq configuration calls, including the generic and protected shapes such as
 * `Protected().Setup<Task<HttpResponseMessage>>(...)`. `ThrowsAsync`/
 * `ThrowAsync` chained to one of these arranges mock behaviour; it is not an
 * assertion and is never awaited.
 */
const MOQ_CONFIGURATION =
    /\.(?:Setup|SetupSet|SetupSequence)\s*(?:<[^(]*>\s*)?\(/u;

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
        // The mask blanks literals in place, so the raw body shares its
        // offsets: quote the original when the message needs to be readable.
        const raw = declaration.body ?? body;
        return [...body.matchAll(ASYNC_ASSERTION)].flatMap(
            (match): TestHygieneFinding[] => {
                const index = match.index ?? 0;
                const start = statementStart(body, index);
                const prefix = body.slice(start, index);
                // A ThrowsAsync/ThrowAsync chained to a Moq setup call is mock
                // configuration, not an assertion.
                if (
                    /ThrowsAsync|ThrowAsync/u.test(match[0]) &&
                    MOQ_CONFIGURATION.test(prefix)
                ) {
                    return [];
                }
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
                        message: `unawaited async assertion in test "${declaration.name}": "${collapse(raw.slice(start, statementEnd(body, index)))}" — it never runs unless awaited or returned`,
                    },
                ];
            },
        );
    });
}

/** A catch clause with its block. A promise `.catch(` does not match. */
const CATCH_OPEN = /\b(?<!\.)catch\s*(?:(?:\([^)]*\))\s*)?\{/g;

/**
 * Index of the bracket closing the one at `open`, or the last index when the
 * body is unbalanced. Only the bracket kind at `open` is matched; the text is
 * already masked, so a bracket inside a string cannot close the block.
 */
function matchingClose(text: string, open: number): number {
    const opener = text[open] ?? "";
    const closer = opener === "{" ? "}" : ")";
    let depth = 0;
    for (let index = open; index < text.length; index++) {
        if (text[index] === opener) {
            depth++;
        } else if (text[index] === closer) {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return text.length - 1;
}

/** Index of the bracket opening the block closed at `close`, or `-1`. */
function matchingOpen(text: string, close: number): number {
    const closer = text[close] ?? "";
    const opener = closer === "}" ? "{" : ")";
    let depth = 0;
    for (let index = close; index >= 0; index--) {
        if (text[index] === closer) {
            depth++;
        } else if (text[index] === opener) {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
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
                const close = matchingClose(body, open);
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
                        message: `swallowed exception in test "${declaration.name}": "${collapse((declaration.body ?? body).slice(index, index + match[0].length).replace(/\{$/u, ""))}" neither asserts nor rethrows, so the test passes when anything throws`,
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

/** One phase a structure label can name. */
type PhaseLabel = "arrange" | "act" | "assert";

/** Phase labels in canonical order, for evidence text. */
const PHASE_LABELS: readonly PhaseLabel[] = ["arrange", "act", "assert"];

/**
 * A comment line, capturing the label text after the comment marker. The
 * capture takes the raw remainder; the phase-word scan works from word
 * boundaries, so leading whitespace is inert.
 */
const COMMENT_LINE = /^[ \t]*(?:\/\/|#(?:region )?|\/\*|\*|--)(.*)$/;

/** A phase word inside a comment's label text. Stateful: reset per line. */
const PHASE_WORD = /\b(arrange|act|assert)\b/gi;

/**
 * What may follow a phase word for it to name a phase: a joiner (`&`, `/`,
 * `,`, `+`, `and`), a dash, a colon, a trailing block-comment close, or the
 * end of the comment. A dot (`Assert.Equal`) or prose (`Arrange the folder`)
 * does not.
 */
const PHASE_FOLLOWER = /^[ \t]*(?:\*\/[ \t]*)?(?:[&/,+]|and\b|[:—–-]|$)/i;

/** One body line's phase labels. */
interface PhaseEntry {
    /** 0-based line index inside the declaration body. */
    readonly lineIndex: number;
    readonly labels: ReadonlySet<PhaseLabel>;
}

/**
 * The phase labels each comment line of the body names, in body order.
 * Strings are masked with comments kept, so a label quoted inside a fixture
 * is data, not a phase, and an apostrophe in prose cannot open a literal.
 */
function labelLines(body: string): PhaseEntry[] {
    const lines = maskTestSource(body, { comments: "keep" }).split("\n");
    const entries: PhaseEntry[] = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const text = COMMENT_LINE.exec(lines[lineIndex] ?? "")?.[1];
        if (text === undefined) {
            continue;
        }
        PHASE_WORD.lastIndex = 0;
        const labels = new Set<PhaseLabel>();
        for (const word of text.matchAll(PHASE_WORD)) {
            const after = text.slice((word.index ?? 0) + word[0].length);
            if (PHASE_FOLLOWER.test(after)) {
                labels.add((word[1] ?? "").toLowerCase() as PhaseLabel);
            }
        }
        if (labels.size > 0) {
            entries.push({ lineIndex, labels });
        }
    }
    return entries;
}

/**
 * Whether a masked body line holds a real statement. The block's own opening
 * brace is a delimiter, not a statement.
 */
function isStatementLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed !== "" && trimmed !== "{";
}

/*
 * Count depth-0 statements in a masked region: a semicolon outside every
 * bracket. Paren and bracket depth keeps `for (;;)` headers and nested
 * lambdas above zero, so only statements of the region itself count.
 *
 * ponytail: counting `;` reads no language whose statements end in a
 * newline — Python and Go bodies count 0 and never fire. The upgrade path is a
 * per-language statement splitter.
 */
function topLevelStatements(slice: string): number {
    let depth = 0;
    let count = 0;
    for (const character of slice) {
        if (character === "{" || character === "(" || character === "[") {
            depth++;
        } else if (
            character === "}" ||
            character === ")" ||
            character === "]"
        ) {
            depth = Math.max(0, depth - 1);
        } else if (character === ";" && depth === 0) {
            count++;
        }
    }
    return count;
}

/** A label line's phases, capitalised and joined for evidence text. */
function regionName(labels: ReadonlySet<PhaseLabel>): string {
    return PHASE_LABELS.filter((label) => labels.has(label))
        .map((label) => label.charAt(0).toUpperCase() + label.slice(1))
        .join(" & ");
}

/** All phases the body's label comments name. */
function phasesFound(entries: readonly PhaseEntry[]): Set<PhaseLabel> {
    const found = new Set<PhaseLabel>();
    for (const entry of entries) {
        for (const label of entry.labels) {
            found.add(label);
        }
    }
    return found;
}

/**
 * The missing-structure lead, or `null` when the body is structured: act and
 * assert both labelled — separately or combined — and arrange labelled or
 * unpreceded by any statement. A fabricated empty `// Arrange` names a phase
 * that does not exist, so a no-arrangement test is never asked for one.
 */
function missingStructureFinding(
    declaration: TestDeclaration,
    entries: readonly PhaseEntry[],
    found: ReadonlySet<PhaseLabel>,
): TestHygieneFinding | null {
    const firstLabelLine = entries[0]?.lineIndex;
    const statementsBefore = (declaration.maskedBody ?? "")
        .split("\n")
        .slice(0, firstLabelLine)
        .some(isStatementLine);

    if (
        found.has("act") &&
        found.has("assert") &&
        (found.has("arrange") || !statementsBefore)
    ) {
        return null;
    }

    const present = PHASE_LABELS.filter((label) => found.has(label));
    const evidence =
        present.length === 0 ? "found: none" : `found: ${present.join(", ")}`;
    return {
        rule: "missing-structure",
        file: declaration.path,
        line: declaration.line,
        message: `test "${declaration.name}" has incomplete phase structure (${evidence}): Act and Assert must be labelled, and Arrange only when statements precede the first label`,
    };
}

/**
 * The multi-statement-act lead for the first act-bearing region — from its
 * label to the next label or the body's end — or `null` when the region holds
 * one statement or cannot be read. A second depth-0 statement means more than
 * one outcome is pinned, or an act and an assert share a label.
 */
function multiStatementActFinding(
    declaration: TestDeclaration,
    entries: readonly PhaseEntry[],
): TestHygieneFinding | null {
    const actIndex = entries.findIndex((entry) => entry.labels.has("act"));
    const actEntry = entries[actIndex];
    if (actEntry === undefined || declaration.maskedBody === null) {
        return null;
    }
    const regionEnd = entries[actIndex + 1]?.lineIndex;
    const region = declaration.maskedBody
        .split("\n")
        .slice(actEntry.lineIndex + 1, regionEnd)
        .join("\n");
    const statements = topLevelStatements(region);
    if (statements <= 1) {
        return null;
    }
    return {
        rule: "multi-statement-act",
        file: declaration.path,
        line: declaration.bodyLine + actEntry.lineIndex,
        message: `test "${declaration.name}" act region (region: ${regionName(actEntry.labels)}; statements: ${statements}) holds more than one depth-0 statement: one statement is the expected shape`,
    };
}

/** A conditional block that can hold an assertion. */
const CONDITIONAL_OPEN = /\bif\s*\([^)]*\)\s*\{/g;

/** A braceless conditional whose body is an assertion. */
const CONDITIONAL_BARE_CALL =
    /\bif\s*\([^)]*\)\s*(?=(?:Assert|Assertions|assert|expect|Should)[.(])/g;

/** The Python one-liner: `if cond: assert ...`. */
const CONDITIONAL_BARE_PYTHON = /\bif\b[^:{]*:[ \t]*(?=assert\b)/g;

/** A loop block that can hold an assertion. */
const LOOP_OPEN = /\b(?:for|foreach|while)\s*\([^)]*\)\s*\{/g;

/** A call whose callback can hold an assertion. */
const FOR_EACH_CALL = /\.forEach\s*\(/g;

/** An `else` clause with a block. */
const ELSE_BLOCK = /\belse\s*\{/g;

/** A braceless `else` whose statement is an assertion. */
const ELSE_BARE =
    /\belse\b(?!\s*if\b)\s*(?=(?:Assert|Assertions|assert|expect|Should)[.(])/g;

/**
 * Boolean assertion calls whose operand can join two conditions. The
 * capital-`A` `Assert.` family is the assertion framework's own class; any
 * other receiver (`fc.assert`, `t.assert`) is treated as a wrapper and stays
 * silent.
 */
const BOOLEAN_ASSERTION =
    /\b(?:Assert\.(?:True|IsTrue|False|IsFalse|That)|(?<![\w$.])(?:assert(?:\.ok)?|assertTrue|assertFalse))\s*\(/g;

/**
 * The receiver immediately before a `.forEach` match, so evidence names the
 * call: `items.forEach(`.
 */
function receiverBefore(body: string, start: number): string {
    let index = start;
    while (index > 0 && /[A-Za-z0-9_$.]/.test(body[index - 1] ?? "")) {
        index--;
    }
    return body.slice(index, start);
}

/** A block header without its opening brace, so evidence reads `if (x)`. */
function headerText(text: string): string {
    const trimmed = text.trimEnd();
    return trimmed.endsWith("{") ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

/** Whether the branch immediately before `else` also holds an assertion. */
function previousBranchAsserts(body: string, elseIndex: number): boolean {
    let before = elseIndex - 1;
    while (before >= 0 && /\s/.test(body[before] ?? "")) {
        before--;
    }
    if (body[before] === "}") {
        const open = matchingOpen(body, before);
        return open >= 0 && ASSERTION_VERB.test(body.slice(open + 1, before));
    }
    if (body[before] === ";") {
        const statement = body.slice(statementStart(body, before), before + 1);
        return /^\s*if\s*\(/.test(statement) && ASSERTION_VERB.test(statement);
    }
    return false;
}

/** Matches of a block-opening pattern whose bracket-matched block asserts. */
function assertionBlocks({
    body,
    pattern,
    evidenceOf,
}: {
    body: string;
    pattern: RegExp;
    evidenceOf: (body: string, index: number, matchText: string) => string;
}): Array<{ index: number; evidence: string }> {
    return [...body.matchAll(pattern)].flatMap((match) => {
        const index = match.index ?? 0;
        const open = index + match[0].length - 1;
        const close = matchingClose(body, open);
        if (!ASSERTION_VERB.test(body.slice(open + 1, close))) {
            return [];
        }
        return [{ index, evidence: evidenceOf(body, index, match[0]) }];
    });
}

/** One finding for a matched assertion shape inside a block. */
function assertionFinding({
    declaration,
    body,
    rule,
    match,
    message,
}: {
    declaration: TestDeclaration;
    body: string;
    rule: ReviewRule;
    match: { index: number; evidence: string };
    message: (evidence: string) => string;
}): TestHygieneFinding {
    return {
        rule,
        file: declaration.path,
        line: lineInBody({
            body,
            bodyLine: declaration.bodyLine,
            index: match.index,
        }),
        message: message(match.evidence),
    };
}

/** Assertions inside a conditional block or a braceless guard. */
function conditionalAssertionFindings({
    entries,
}: {
    entries: readonly ReviewedDeclaration[];
}): TestHygieneFinding[] {
    return entries.flatMap(
        ({ declaration, suppressed }): TestHygieneFinding[] => {
            const body = declaration.maskedBody;
            if (body === null || suppressed.has("conditional-assertion")) {
                return [];
            }
            const blocks = assertionBlocks({
                body,
                pattern: CONDITIONAL_OPEN,
                evidenceOf: (_body, _index, text) => headerText(text),
            });
            const bare = [
                CONDITIONAL_BARE_CALL,
                CONDITIONAL_BARE_PYTHON,
            ].flatMap((pattern) =>
                [...body.matchAll(pattern)].map((match) => ({
                    index: match.index ?? 0,
                    evidence: headerText(match[0]),
                })),
            );
            return [...blocks, ...bare].map((match) =>
                assertionFinding({
                    declaration,
                    body,
                    rule: "conditional-assertion",
                    match,
                    message: (evidence) =>
                        `assertion guarded by a conditional in test "${declaration.name}": "${collapse(evidence)}" — it may never run, let alone fail`,
                }),
            );
        },
    );
}

/** Assertions inside a loop body or a forEach callback. */
function loopAssertionFindings({
    entries,
}: {
    entries: readonly ReviewedDeclaration[];
}): TestHygieneFinding[] {
    return entries.flatMap(
        ({ declaration, suppressed }): TestHygieneFinding[] => {
            const body = declaration.maskedBody;
            if (body === null || suppressed.has("assertion-in-loop")) {
                return [];
            }
            const loops = assertionBlocks({
                body,
                pattern: LOOP_OPEN,
                evidenceOf: (_body, _index, text) => headerText(text),
            });
            const callbacks = assertionBlocks({
                body,
                pattern: FOR_EACH_CALL,
                evidenceOf: (text, index) =>
                    `${receiverBefore(text, index)}.forEach(`,
            });
            return [...loops, ...callbacks].map((match) =>
                assertionFinding({
                    declaration,
                    body,
                    rule: "assertion-in-loop",
                    match,
                    message: (evidence) =>
                        `assertion inside a loop in test "${declaration.name}": "${collapse(evidence)}" — several cases reported as one test, only the first failure visible`,
                }),
            );
        },
    );
}

/** Assertions in an else branch: the outcome depends on the branch taken. */
function elseBranchFindings({
    entries,
}: {
    entries: readonly ReviewedDeclaration[];
}): TestHygieneFinding[] {
    return entries.flatMap(
        ({ declaration, suppressed }): TestHygieneFinding[] => {
            const body = declaration.maskedBody;
            if (body === null || suppressed.has("else-branch-assertion")) {
                return [];
            }
            const blocks = assertionBlocks({
                body,
                pattern: ELSE_BLOCK,
                evidenceOf: () => "",
            }).map((match) => ({
                ...match,
                evidence: previousBranchAsserts(body, match.index)
                    ? "both branches assert"
                    : "else branch asserts",
            }));
            const bare = [...body.matchAll(ELSE_BARE)].map((match) => ({
                index: match.index ?? 0,
                evidence: previousBranchAsserts(body, match.index ?? 0)
                    ? "both branches assert"
                    : "else branch asserts",
            }));
            return [...blocks, ...bare].map((match) =>
                assertionFinding({
                    declaration,
                    body,
                    rule: "else-branch-assertion",
                    match,
                    message: (evidence) =>
                        `asserting else branch in test "${declaration.name}": ${evidence} — a different outcome per branch should be parameterised or split`,
                }),
            );
        },
    );
}

/** Two conditions joined in one boolean assertion: one ambiguous failure. */
function compoundAssertionFindings({
    entries,
}: {
    entries: readonly ReviewedDeclaration[];
}): TestHygieneFinding[] {
    return entries.flatMap(
        ({ declaration, suppressed }): TestHygieneFinding[] => {
            const body = declaration.maskedBody;
            if (body === null || suppressed.has("compound-assertion")) {
                return [];
            }
            return [...body.matchAll(BOOLEAN_ASSERTION)].flatMap(
                (match): TestHygieneFinding[] => {
                    const index = match.index ?? 0;
                    const open = index + match[0].length - 1;
                    const close = matchingClose(body, open);
                    if (!/[&|]{2}/.test(body.slice(open + 1, close))) {
                        return [];
                    }
                    return [
                        {
                            rule: "compound-assertion",
                            file: declaration.path,
                            line: lineInBody({
                                body,
                                bodyLine: declaration.bodyLine,
                                index,
                            }),
                            message: `compound boolean assertion in test "${declaration.name}": "${collapse((declaration.body ?? body).slice(index, close + 1))}" — the failure message cannot say which condition broke`,
                        },
                    ];
                },
            );
        },
    );
}

/** One source's structure leads: phase coverage and the act region's shape. */
function structureFindings({
    entries,
}: {
    entries: readonly ReviewedDeclaration[];
}): TestHygieneFinding[] {
    return entries.flatMap(
        ({ declaration, suppressed }): TestHygieneFinding[] => {
            // A delimited block is the only body a label can mark.
            if (
                declaration.body === null ||
                declaration.maskedBody === null ||
                !declaration.body.startsWith("{")
            ) {
                return [];
            }
            const labels = labelLines(declaration.body);
            const found = phasesFound(labels);
            return [
                suppressed.has("missing-structure")
                    ? null
                    : missingStructureFinding(declaration, labels, found),
                suppressed.has("multi-statement-act")
                    ? null
                    : multiStatementActFinding(declaration, labels),
            ].filter(
                (finding): finding is TestHygieneFinding => finding !== null,
            );
        },
    );
}

/** All findings from one source, in line order. */
function sourceFindings(
    source: TestReviewSource,
    { review }: { review: boolean },
): TestHygieneFinding[] {
    const masked = maskTestSource(source.content);
    const declarations = scanTestDeclarations({
        path: source.path,
        content: source.content,
    });
    const suppressions = declarations.map((declaration) =>
        readSuppressions({
            file: source.path,
            content: source.content,
            line: declaration.line,
        }),
    );
    const entries: ReviewedDeclaration[] = declarations.map(
        (declaration, index) => ({
            declaration,
            suppressed: suppressions[index]?.suppressed ?? new Set(),
        }),
    );
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
        ...(review
            ? [
                  ...suppressions.flatMap((entry) => entry.faults),
                  ...structureFindings({ entries }),
                  ...conditionalAssertionFindings({ entries }),
                  ...loopAssertionFindings({ entries }),
                  ...elseBranchFindings({ entries }),
                  ...compoundAssertionFindings({ entries }),
                  ...determinismFindings({ source, entries }),
                  ...propertySeedFindings({ source, masked, entries }),
              ]
            : []),
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
 * Run the rule set over the named sources.
 *
 * @param sources Files to read, already read from disk by the caller.
 * @param options the parameter object
 * @param options.review `true` adds the review-tier leads; every other
 *   surface reports the always-on defects only.
 * @returns Findings ordered by file, line and rule.
 */
export function reviewTestSources(
    sources: readonly TestReviewSource[],
    { review = false }: { readonly review?: boolean } = {},
): TestHygieneFinding[] {
    return sources
        .flatMap((source) => sourceFindings(source, { review }))
        .sort(compareFindings);
}
