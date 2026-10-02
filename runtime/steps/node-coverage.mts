// steps/node-coverage.mts — Node/JS coverage gate: parse lcov, enforce minimums.
//
// Tools:    none (runs the consumer's coverage command; parses lcov)
// Config:   .defined.json "coverage.node" — command + minimums
// Fix:      none — coverage generation is verification, so repair skips and it
//           runs once in the no-fix pass (#65)
// No-fix:   runs the consumer's coverage command in a /tmp scratch copy of the
//           git scope (a read-only verify cannot write a report into the repo)
//           and validates the scratch report
// Skip:     no .defined.json entry for "node", or no coverage/lcov.info found
//
// Detection is config-driven: the step only activates when .defined.json
// includes a "coverage.node" entry. The consumer provides the shell command
// to generate coverage reports; the gate parses the resulting lcov.info
// and enforces line/branch/function minimums.
// The runner is injected so tests need no host binaries.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
    errored,
    failed,
    passed,
    skipped,
    type StepResult,
} from "../lib/step-result.mts";
import { runScopedCommand } from "../lib/coverage.mts";
import type { Scratch } from "../lib/scratch.mts";
import { run } from "../../lib/proc.mts";
import { loadConfig, type CoverageMinimums } from "../lib/config.mts";

export interface NodeCoverageRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the dotnet + coverage steps. */
    scratch?: Scratch;
    /** Write-capable invocation: no-fix keeps the report in the repo (comply). */
    repoWritable?: boolean;
}

type Runner = typeof run;

export interface LcovSummary {
    linesFound: number;
    linesHit: number;
    branchesFound: number;
    branchesHit: number;
    functionsFound: number;
    functionsHit: number;
}

const LCOV_PATH = "coverage/lcov.info";

/** A malformed lcov counter; the report cannot be trusted for a verdict. */
export class LcovError extends Error {}

const NON_NEGATIVE_INTEGER = /^\d+$/;

/** lcov counter prefixes, with the record field each populates. */
const COUNTERS = [
    { prefix: "LF:", key: "LF" },
    { prefix: "LH:", key: "LH" },
    { prefix: "BRF:", key: "BRF" },
    { prefix: "BRH:", key: "BRH" },
    { prefix: "FNF:", key: "FNF" },
    { prefix: "FNH:", key: "FNH" },
] as const;

type CounterField = (typeof COUNTERS)[number]["key"];

type RecordCounters = Partial<Record<CounterField, number>>;

function counterValue({ field, raw }: { field: string; raw: string }): number {
    const value = raw.trim();
    if (!NON_NEGATIVE_INTEGER.test(value)) {
        throw new LcovError(
            `${field} counter '${raw.trim()}' is not a non-negative integer`,
        );
    }
    return Number(value);
}

/** A record's hits can never exceed its founds. */
function validateRecord(record: RecordCounters): void {
    for (const [foundField, hitField, label] of [
        ["LF", "LH", "line"],
        ["BRF", "BRH", "branch"],
        ["FNF", "FNH", "function"],
    ] as const) {
        const found = record[foundField];
        const hit = record[hitField];
        if (found !== undefined && hit !== undefined && hit > found) {
            throw new LcovError(
                `${label} hit count ${hit} exceeds found count ${found}`,
            );
        }
    }
}

/**
 * Parse an lcov string and aggregate coverage across all source files.
 * Counters are validated per record before aggregation, so a malformed value
 * or a hit count exceeding a found count anywhere fails loudly rather than
 * producing a NaN that silently passes a threshold. Throws `LcovError`; a
 * report with no counters yields zeros.
 */
export function parseLcov({ content }: { content: string }): LcovSummary {
    const totals: LcovSummary = {
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
    };
    let record: RecordCounters = {};
    const flush = (): void => {
        validateRecord(record);
        totals.linesFound += record.LF ?? 0;
        totals.linesHit += record.LH ?? 0;
        totals.branchesFound += record.BRF ?? 0;
        totals.branchesHit += record.BRH ?? 0;
        totals.functionsFound += record.FNF ?? 0;
        totals.functionsHit += record.FNH ?? 0;
        record = {};
    };

    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        const counter = COUNTERS.find((entry) =>
            trimmed.startsWith(entry.prefix),
        );
        if (counter !== undefined) {
            record[counter.key] = counterValue({
                field: counter.key,
                raw: trimmed.slice(counter.prefix.length),
            });
        } else if (trimmed === "end_of_record") {
            flush();
        }
    }
    flush();

    return totals;
}

/** The summary counter pairs, with the label used in failures. */
const SUMMARY_PAIRS = [
    ["line", "linesFound", "linesHit", "line"],
    ["branch", "branchesFound", "branchesHit", "branch"],
    ["function", "functionsFound", "functionsHit", "function"],
] as const;

/** Invalid summary counters (non-integer, negative, or hit exceeding found). */
function counterFailures(summary: LcovSummary): string[] {
    const failures: string[] = [];
    for (const [label, foundField, hitField] of SUMMARY_PAIRS) {
        const found = summary[foundField];
        const hit = summary[hitField];
        if (
            !Number.isInteger(found) ||
            found < 0 ||
            !Number.isInteger(hit) ||
            hit < 0
        ) {
            failures.push(
                `${label}: invalid counters (found ${found}, hit ${hit})`,
            );
        } else if (hit > found) {
            failures.push(
                `${label}: hit count ${hit} exceeds found count ${found}`,
            );
        }
    }
    return failures;
}

/** One minimum comparison: a percentage failure line, or null when it passes. */
function compareMinimum({
    label,
    found,
    hit,
    minimum,
}: {
    label: string;
    found: number;
    hit: number;
    minimum: number;
}): string | null {
    const pct = found > 0 ? (hit / found) * 100 : 0;
    if (pct >= minimum) {
        return null;
    }
    return `${label}: ${pct.toFixed(1)}% < ${minimum}% minimum`;
}

/**
 * Enforce configured minimums against an lcov summary. A malformed summary
 * fails before any comparison, so NaN arithmetic can never read as compliance.
 */
export function checkMinimums({
    summary,
    minimums,
}: {
    summary: LcovSummary;
    minimums: CoverageMinimums;
}): { pass: boolean; failures: string[] } {
    const invalid = counterFailures(summary);
    if (invalid.length > 0) {
        return { pass: false, failures: invalid };
    }

    const failures: string[] = [];
    for (const [label, foundField, hitField, minimumKey] of SUMMARY_PAIRS) {
        const minimum = minimums[minimumKey];
        if (minimum === undefined) {
            continue;
        }
        const failure = compareMinimum({
            label,
            found: summary[foundField],
            hit: summary[hitField],
            minimum,
        });
        if (failure !== null) {
            failures.push(failure);
        }
    }
    return { pass: failures.length === 0, failures };
}

/**
 * Effective minimums: consumer-provided minimums override the 80% line
 * default. When minimums key is absent entirely, default to 80% line only.
 */
function effectiveMinimums(
    configMinimums: CoverageMinimums | undefined,
): CoverageMinimums {
    if (configMinimums === undefined) {
        return { line: 80 };
    }
    return configMinimums;
}

/**
 * Parse the report at `lcovPath` from a working root. Returns the summary, or
 * a step result when the report is missing, unreadable or malformed.
 */
async function readSummary({
    workingRoot,
    readFileFn,
}: {
    workingRoot: string;
    readFileFn: typeof readFile;
}): Promise<LcovSummary | StepResult> {
    const lcovPath = join(workingRoot, LCOV_PATH);
    if (!existsSync(lcovPath)) {
        return failed({
            notice: `node-coverage: no coverage report at ${LCOV_PATH} — run coverage in a prior step or check command`,
        });
    }
    const content = await readFileFn(lcovPath, "utf8");
    try {
        const summary = parseLcov({ content });
        if (summary.linesFound === 0) {
            return failed({
                notice: "node-coverage: lcov report contains no line data",
            });
        }
        return summary;
    } catch (err) {
        if (err instanceof LcovError) {
            return errored({
                message: `node-coverage: invalid lcov report: ${err.message}`,
            });
        }
        throw err;
    }
}

/** A parsed summary is distinguishable from a returned step result. */
function isSummary(value: LcovSummary | StepResult): value is LcovSummary {
    return "linesFound" in value;
}

/**
 * Run Node.js coverage gate. Skips when no config entry. Repair (fix) skips —
 * coverage generation is verification (#65). No-fix runs the consumer's command
 * in a /tmp scratch copy of the git scope (a read-only verify cannot write a
 * report into the repo), then validates the report against configured minimums.
 */
export async function runNodeCoverageStep({
    ctx,
    trackedFiles,
    runner = run,
    readFileFn = readFile,
}: {
    ctx: NodeCoverageRunContext;
    trackedFiles: string[];
    runner?: Runner;
    readFileFn?: typeof readFile;
}): Promise<StepResult> {
    const config = await loadConfig({ repoRoot: ctx.repoRoot, readFileFn });
    if (!config.coverage?.node) {
        return skipped({
            notice: "node-coverage: no coverage.node entry in .defined.json",
        });
    }

    const coverageConfig = config.coverage.node;

    // Repair (#65): coverage generation is verification, not mutation; it runs
    // once, in the authoritative no-fix pass.
    if (ctx.mode === "fix") {
        return skipped({
            notice: "node-coverage: deferred to verification",
        });
    }

    // Read-only verify cannot write a report into /repo, so no-fix runs the
    // consumer's command against a scratch copy of the git scope (shared with
    // the dotnet steps via ctx.scratch) and validates the scratch report. A
    // write-capable comply instead keeps the report in the repo (the artifact
    // SonarQube reads).
    const { workingRoot, failure } = runScopedCommand({
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
            notice: `node-coverage: coverage command failed: ${failure}`,
        });
    }

    const parsed = await readSummary({ workingRoot, readFileFn });
    if (!isSummary(parsed)) {
        return parsed;
    }

    const minimums = effectiveMinimums(coverageConfig.minimums);
    const { pass, failures } = checkMinimums({ summary: parsed, minimums });

    if (!pass) {
        return failed({
            notice: `node-coverage: ${failures.join("; ")}`,
        });
    }

    const pct = ((parsed.linesHit / parsed.linesFound) * 100).toFixed(1);
    return passed({
        notice: `node-coverage: ${pct}% line coverage (${parsed.linesHit}/${parsed.linesFound})`,
    });
}
