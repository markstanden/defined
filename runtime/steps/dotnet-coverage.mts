// steps/dotnet-coverage.mts — .NET coverage gate: parse Cobertura, enforce minimums.
//
// Tools:    none (runs the consumer's coverage command; parses Cobertura)
// Config:   .defined.json "coverage.dotnet" — command + minimums
// Fix:      none — coverage generation is verification, so repair skips and it
//           runs once in the no-fix pass (#65)
// No-fix:   runs the consumer's coverage command and validates the report. A
//           read-only verify runs it in a /tmp scratch copy of the git scope
//           (it cannot write into the repo); a write-capable comply keeps the
//           report in the repo, where a scanner reads it
// Skip:     dotnet disabled by .defined.json, no .defined.json entry for
//           "dotnet", or no Cobertura XML found
//
// Detection is config-driven: the step only activates when .defined.json
// includes a "coverage.dotnet" entry. The consumer provides the shell command
// to generate coverage reports; the gate parses the resulting Cobertura XML
// and enforces line/branch minimums.
// The runner is injected so tests need no host binaries.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
    failed,
    passed,
    skipped,
    type StepResult,
} from "../lib/step-result.mts";
import { formatPercent, runScopedCommand } from "../lib/coverage.mts";
import type { Scratch } from "../lib/scratch.mts";
import { run } from "../../lib/proc.mts";
import {
    loadConfig,
    type CoverageConfig,
    type CoverageMinimums,
} from "../lib/config.mts";

export interface DotNetCoverageRunContext {
    /** Repair (fix) or authoritative verification (no-fix) — see comply #65. */
    mode: "fix" | "no-fix";
    /** Repo root the checkout was mounted at; scratch copies hang off it. */
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the dotnet + coverage steps. */
    scratch?: Scratch;
    /** Write-capable invocation: no-fix keeps the report in the repo (comply). */
    repoWritable?: boolean;
}

type Runner = typeof run;

const COBERTURA_NAME = "coverage.cobertura.xml";

/**
 * An exact non-negative decimal rate as a Cobertura report writes it:
 * `value / 10^scale` (`"0.29"` is `{ value: 29n, scale: 2 }`). Keeping the
 * decimal exact lets the minimum comparison stay in integer arithmetic —
 * `0.29 * 100` is 28.999999999999996 as a double.
 */
export interface CoberturaRate {
    /** Unscaled digits: `"0.29"` -> `29n`. */
    value: bigint;
    /** Decimal places: `"0.29"` -> `2`. */
    scale: number;
}

export interface CoberturaSummary {
    /** Line coverage rate, parsed from a Cobertura XML file. */
    lineRate: CoberturaRate;
    /** Branch coverage rate; undefined when the report omits it. */
    branchRate: CoberturaRate | undefined;
}

/** A zero rate, used when the report carries no rate attribute. */
const ZERO_RATE: CoberturaRate = { value: 0n, scale: 0 };

/** The decimal form a Cobertura `*-rate` attribute uses. */
const RATE_RE = /^\d+(?:\.(\d+))?$/u;

/**
 * Parse a Cobertura rate attribute exactly. Returns undefined when the
 * attribute is absent or not a plain decimal (for example an exponent form),
 * matching the previous "no usable rate" handling.
 */
export function parseRate(attr: string | undefined): CoberturaRate | undefined {
    if (attr === undefined) {
        return undefined;
    }
    const text = attr.trim();
    const match = RATE_RE.exec(text);
    if (match === null) {
        return undefined;
    }
    return {
        value: BigInt(text.replace(".", "")),
        scale: match[1]?.length ?? 0,
    };
}

/** The rate as written in the report, for a failure message (`"0.29"`). */
function rateText({ value, scale }: CoberturaRate): string {
    const digits = value.toString().padStart(scale + 1, "0");
    if (scale === 0) {
        return digits;
    }
    return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** The rate as a floored percentage string (`"0.85"` -> `"85.0"`). */
function formatRate(rate: CoberturaRate): string {
    return formatPercent({
        numerator: rate.value,
        denominator: 10n ** BigInt(rate.scale),
    });
}

/**
 * Parse a Cobertura XML document. Extracts `line-rate` and `branch-rate` from
 * the root `<coverage>` element as exact decimals. Returns a zero line rate
 * when the rates are absent.
 */
export function parseCobertura({
    content,
}: {
    content: string;
}): CoberturaSummary {
    const lineRate = parseRate(extractAttribute(content, "line-rate"));
    const branchRate = parseRate(extractAttribute(content, "branch-rate"));
    return {
        lineRate: lineRate ?? ZERO_RATE,
        branchRate,
    };
}

/**
 * Extract a single attribute value from the first tag in an XML string.
 * Handles single/double quotes and decimal forms. Returns undefined when the
 * attribute is not present.
 */
function extractAttribute(xml: string, name: string): string | undefined {
    const re = new RegExp(String.raw`${name}\s*=\s*["']([^"']*)["']`, "u");
    const match = re.exec(xml);
    return match?.[1];
}

/**
 * Compare one rate against its minimum exactly, returning a failure message or
 * null. Cobertura rates are decimal strings, so the comparison is integer
 * arithmetic on the unscaled value — `rate * 100 >= minimum` as a float can
 * fail at an exact boundary (0.29 * 100 is 28.999999999999996).
 */
function compareRate({
    label,
    rate,
    minimum,
}: {
    label: string;
    rate: CoberturaRate;
    minimum: number;
}): string | null {
    const found = 10n ** BigInt(rate.scale);
    if (rate.value * 100n >= BigInt(minimum) * found) {
        return null;
    }
    return `${label}: ${formatRate(rate)}% (${rateText(rate)}) < ${minimum}% minimum`;
}

/**
 * Compare a Cobertura summary against the configured minimums.
 *
 * @param root0 the parameter object
 * @param root0.summary parsed Cobertura rates, exact decimals
 * @param root0.minimums configured per-metric floors, integer percentages
 * @returns pass=false with one failure message per metric below its floor
 */
export function checkMinimums({
    summary,
    minimums,
}: {
    summary: CoberturaSummary;
    minimums: CoverageMinimums;
}): {
    /** False when any tracked metric sits below its minimum. */
    pass: boolean;
    /** One per failed metric: `line/branch: <pct>% (<rate>) < <minimum>% minimum`. */
    failures: string[];
} {
    const failures: string[] = [];

    if (minimums.line !== undefined) {
        const failure = compareRate({
            label: "line",
            rate: summary.lineRate,
            minimum: minimums.line,
        });
        if (failure !== null) {
            failures.push(failure);
        }
    }

    if (minimums.branch !== undefined) {
        if (summary.branchRate === undefined) {
            failures.push(
                `branch: report has no branch-rate data (minimum ${minimums.branch}%)`,
            );
        } else {
            const failure = compareRate({
                label: "branch",
                rate: summary.branchRate,
                minimum: minimums.branch,
            });
            if (failure !== null) {
                failures.push(failure);
            }
        }
    }

    if (minimums.function !== undefined) {
        // Cobertura XML from coverlet does not expose a single function-rate
        // attribute; function-level coverage is not a stable top-level metric
        // we can aggregate reliably. A configured function minimum cannot be
        // satisfied, so fail loudly rather than silently ignoring it.
        failures.push(
            `function: report format has no function coverage (minimum ${minimums.function}%)`,
        );
    }

    return { pass: failures.length === 0, failures };
}

function effectiveMinimums(
    configMinimums: CoverageMinimums | undefined,
): CoverageMinimums {
    if (configMinimums === undefined) {
        return { line: 80 };
    }
    return configMinimums;
}

function findCoberturaFile({ repoRoot }: { repoRoot: string }): string | null {
    const candidates = [
        join(repoRoot, COBERTURA_NAME),
        join(repoRoot, "TestResults", COBERTURA_NAME),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Run dotnet coverage gate. Skips when no config entry; runs the consumer's
 * command once in the authoritative no-fix pass, in a /tmp scratch copy of the
 * git scope (a read-only verify cannot write a report into the repo), then
 * validates the report against configured minimums. Looks for
 * coverage.cobertura.xml at the working root or TestResults/.
 */
/**
 * Locate, read and parse the Cobertura report: `coverage.cobertura.xml` at
 * the working root or under TestResults/. Returns the failed result when the
 * report is missing or contains no coverage data.
 */
async function loadCoberturaSummary({
    workingRoot,
    readFileFn,
}: {
    workingRoot: string;
    readFileFn: typeof readFile;
}): Promise<StepResult | { summary: CoberturaSummary }> {
    const coberturaPath = findCoberturaFile({ repoRoot: workingRoot });
    if (coberturaPath === null) {
        return failed({
            notice: `dotnet-coverage: no coverage report at ${COBERTURA_NAME} (or TestResults/coverage.cobertura.xml) — run coverage in a prior step or check command`,
        });
    }

    const content = await readFileFn(resolve(coberturaPath), "utf8");
    const summary = parseCobertura({ content });

    if (summary.lineRate.value === 0n && summary.branchRate === undefined) {
        return failed({
            notice: "dotnet-coverage: Cobertura XML contains no coverage data",
        });
    }
    return { summary };
}

/**
 * Run the .NET coverage step (see the module header): the consumer's command
 * runs in fix mode only, writing the report into the repo; no-fix parses the
 * Cobertura report and enforces the configured minimums against the scratch
 * copy, so a read-only verify never writes.
 *
 * @param root0 the parameter object
 * @param root0.ctx invocation context (mode, repoRoot, scratch)
 * @param root0.trackedFiles the gate's git-scoped file list
 * @param root0.runner the process runner; injectable for tests
 * @param root0.readFileFn reads the Cobertura XML; injectable for tests
 */
export async function runDotNetCoverageStep({
    ctx,
    trackedFiles,
    runner = run,
    readFileFn = readFile,
}: {
    ctx: DotNetCoverageRunContext;
    trackedFiles: string[];
    runner?: Runner;
    readFileFn?: typeof readFile;
}): Promise<StepResult> {
    const config = await loadConfig({ repoRoot: ctx.repoRoot, readFileFn });
    if (config.dotnet?.disable === true) {
        return skipped({
            notice: "dotnet-coverage: disabled by .defined.json",
        });
    }
    if (!config.coverage?.dotnet) {
        return skipped({
            notice: "dotnet-coverage: no coverage.dotnet entry in .defined.json",
        });
    }

    const coverageConfig = config.coverage.dotnet;

    // Repair (#65): coverage generation is verification, not mutation; it runs
    // once, in the authoritative no-fix pass.
    if (ctx.mode === "fix") {
        return skipped({
            notice: "dotnet-coverage: deferred to verification",
        });
    }

    // Read-only verify cannot write a report into /repo, so no-fix runs the
    // consumer's command against a scratch copy of the git scope (shared with
    // the dotnet step via ctx.scratch) and validates the scratch report. A
    // write-capable comply instead keeps the report in the repo.
    const { workingRoot, failure } = await runScopedCommand({
        mode: ctx.mode,
        repoRoot: ctx.repoRoot,
        scratch: ctx.scratch,
        trackedFiles,
        command: coverageConfig.command,
        runner,
        repoWritable: ctx.repoWritable,
    });
    if (failure !== null) {
        return failed({
            notice: `dotnet-coverage: coverage command failed: ${failure}`,
        });
    }

    return evaluateCobertura({ workingRoot, coverageConfig, readFileFn });
}

/**
 * Validate the generated Cobertura report against the configured minimums:
 * a missing/empty report or a below-minimum metric is a failure, otherwise a
 * pass naming the achieved line coverage.
 */
async function evaluateCobertura({
    workingRoot,
    coverageConfig,
    readFileFn,
}: {
    workingRoot: string;
    coverageConfig: CoverageConfig;
    readFileFn: typeof readFile;
}): Promise<StepResult> {
    const loaded = await loadCoberturaSummary({ workingRoot, readFileFn });
    if (!("summary" in loaded)) {
        return loaded;
    }
    const { summary } = loaded;

    const minimums = effectiveMinimums(coverageConfig.minimums);
    const { pass, failures } = checkMinimums({ summary, minimums });

    if (!pass) {
        return failed({
            notice: `dotnet-coverage: ${failures.join("; ")}`,
        });
    }

    return passed({
        notice: `dotnet-coverage: ${formatRate(summary.lineRate)}% line coverage`,
    });
}
