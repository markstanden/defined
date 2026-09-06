// steps/dotnet-coverage.mts — .NET coverage gate: parse Cobertura, enforce minimums.
//
// Tools:    none (runs the consumer's coverage command; parses Cobertura)
// Config:   .defined.json "coverage.dotnet" — command + minimums
// Fix:      runs the consumer's coverage command in the repo (rw mount), then
//           validates the report
// No-fix:   runs the consumer's coverage command in a /tmp scratch copy of the
//           git scope (a read-only verify cannot write a report into the repo)
//           and validates the scratch report
// Skip:     no .defined.json entry for "dotnet", or no Cobertura XML found
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
import { ensureScratch, type Scratch } from "../lib/scratch.mts";
import { run } from "../../lib/proc.mts";
import { loadConfig, type CoverageMinimums } from "../lib/config.mts";

export interface DotNetCoverageRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the dotnet + coverage steps. */
    scratch?: Scratch;
}

type Runner = typeof run;

const COBERTURA_NAME = "coverage.cobertura.xml";

export interface CoberturaSummary {
    /** 0.0–1.0 */
    lineRate: number;
    /** 0.0–1.0 */
    branchRate: number | undefined;
}

function tryParseFloat(attr: string | undefined): number | undefined {
    if (attr === undefined || attr === "") {
        return undefined;
    }
    const value = Number(attr);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse a Cobertura XML document. Extracts `line-rate` and `branch-rate` from
 * the root `<coverage>` element. Rates are 0.0–1.0. Returns zeros when the
 * rates are absent.
 */
export function parseCobertura({
    content,
}: {
    content: string;
}): CoberturaSummary {
    const lineRate = tryParseFloat(extractAttribute(content, "line-rate"));
    const branchRate = tryParseFloat(extractAttribute(content, "branch-rate"));
    return {
        lineRate: lineRate ?? 0,
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

export function checkMinimums({
    summary,
    minimums,
}: {
    summary: CoberturaSummary;
    minimums: CoverageMinimums;
}): { pass: boolean; failures: string[] } {
    const failures: string[] = [];

    if (minimums.line !== undefined) {
        const pct = summary.lineRate * 100;
        if (pct < minimums.line) {
            failures.push(
                `line: ${pct.toFixed(1)}% < ${minimums.line}% minimum`,
            );
        }
    }

    if (minimums.branch !== undefined) {
        if (summary.branchRate === undefined) {
            failures.push(
                `branch: report has no branch-rate data (minimum ${minimums.branch}%)`,
            );
        } else {
            const pct = summary.branchRate * 100;
            if (pct < minimums.branch) {
                failures.push(
                    `branch: ${pct.toFixed(1)}% < ${minimums.branch}% minimum`,
                );
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
 * Run dotnet coverage gate. Skips when no config entry; always runs the
 * consumer's command — in the repo for fix mode, in a /tmp scratch copy of the
 * git scope for no-fix (read-only verify cannot write a report into the repo)
 * — then validates the report against configured minimums. Looks for
 * coverage.cobertura.xml at the working root or TestResults/.
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
    if (!config.coverage?.dotnet) {
        return skipped({
            notice: "dotnet-coverage: no coverage.dotnet entry in .defined.json",
        });
    }

    const coverageConfig = config.coverage.dotnet;

    // Read-only verify cannot write a report into /repo, so no-fix runs the
    // consumer's command against a scratch copy of the git scope (shared with
    // the dotnet step via ctx.scratch) and validates the scratch report.
    const workingRoot =
        ctx.mode === "no-fix"
            ? ensureScratch({
                  scratch: ctx.scratch,
                  repoRoot: ctx.repoRoot,
                  files: trackedFiles,
              })
            : ctx.repoRoot;

    const result = runner({
        cmd: "sh",
        args: ["-c", coverageConfig.command],
        cwd: workingRoot,
    });
    if (result.status !== 0) {
        // Show stdout first: dotnet writes test/build failures there, while a
        // stray first-run banner (now suppressed in the image) or noise lands
        // on stderr — stderr-first used to mask the real failure.
        const detail = [result.stdout, result.stderr]
            .filter((s) => typeof s === "string")
            .map((s) => s.trim())
            .filter((s) => s !== "")
            .join("\n");
        return failed({
            notice: `dotnet-coverage: coverage command failed: ${detail || "no output"}`,
        });
    }

    const coberturaPath = findCoberturaFile({ repoRoot: workingRoot });
    if (coberturaPath === null) {
        return failed({
            notice: `dotnet-coverage: no coverage report at ${COBERTURA_NAME} (or TestResults/coverage.cobertura.xml) — run coverage in a prior step or check command`,
        });
    }

    const content = await readFileFn(resolve(coberturaPath), "utf8");
    const summary = parseCobertura({ content });

    if (summary.lineRate === 0 && summary.branchRate === undefined) {
        return failed({
            notice: "dotnet-coverage: Cobertura XML contains no coverage data",
        });
    }

    const minimums = effectiveMinimums(coverageConfig.minimums);
    const { pass, failures } = checkMinimums({ summary, minimums });

    if (!pass) {
        return failed({
            notice: `dotnet-coverage: ${failures.join("; ")}`,
        });
    }

    const pct = (summary.lineRate * 100).toFixed(1);
    return passed({
        notice: `dotnet-coverage: ${pct}% line coverage`,
    });
}
