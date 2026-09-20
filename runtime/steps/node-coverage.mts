// steps/node-coverage.mts — Node/JS coverage gate: parse lcov, enforce minimums.
//
// Tools:    none (runs the consumer's coverage command; parses lcov)
// Config:   .defined.json "coverage.node" — command + minimums
// Fix:      runs the consumer's coverage command in the repo (rw mount), then
//           validates the report
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
    failed,
    passed,
    skipped,
    type StepResult,
} from "../lib/step-result.mts";
import { runCoverageCommand } from "../lib/coverage.mts";
import type { Scratch } from "../lib/scratch.mts";
import { run } from "../../lib/proc.mts";
import { loadConfig, type CoverageMinimums } from "../lib/config.mts";

export interface NodeCoverageRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the dotnet + coverage steps. */
    scratch?: Scratch;
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

/**
 * Parse an lcov string and aggregate coverage across all source files.
 * Returns the summed line/branch/function counters. Returns zeros when no
 * data found.
 */
export function parseLcov({ content }: { content: string }): LcovSummary {
    let linesFound = 0;
    let linesHit = 0;
    let branchesFound = 0;
    let branchesHit = 0;
    let functionsFound = 0;
    let functionsHit = 0;

    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("LF:")) {
            linesFound += Number(trimmed.slice(3));
        } else if (trimmed.startsWith("LH:")) {
            linesHit += Number(trimmed.slice(3));
        } else if (trimmed.startsWith("BRF:")) {
            branchesFound += Number(trimmed.slice(4));
        } else if (trimmed.startsWith("BRH:")) {
            branchesHit += Number(trimmed.slice(4));
        } else if (trimmed.startsWith("FNF:")) {
            functionsFound += Number(trimmed.slice(4));
        } else if (trimmed.startsWith("FNH:")) {
            functionsHit += Number(trimmed.slice(4));
        }
    }

    return {
        linesFound,
        linesHit,
        branchesFound,
        branchesHit,
        functionsFound,
        functionsHit,
    };
}

export function checkMinimums({
    summary,
    minimums,
}: {
    summary: LcovSummary;
    minimums: CoverageMinimums;
}): { pass: boolean; failures: string[] } {
    const failures: string[] = [];

    if (minimums.line !== undefined) {
        const pct =
            summary.linesFound > 0
                ? (summary.linesHit / summary.linesFound) * 100
                : 0;
        if (pct < minimums.line) {
            failures.push(
                `line: ${pct.toFixed(1)}% < ${minimums.line}% minimum`,
            );
        }
    }

    if (minimums.branch !== undefined) {
        const pct =
            summary.branchesFound > 0
                ? (summary.branchesHit / summary.branchesFound) * 100
                : 0;
        if (pct < minimums.branch) {
            failures.push(
                `branch: ${pct.toFixed(1)}% < ${minimums.branch}% minimum`,
            );
        }
    }

    if (minimums.function !== undefined) {
        const pct =
            summary.functionsFound > 0
                ? (summary.functionsHit / summary.functionsFound) * 100
                : 0;
        if (pct < minimums.function) {
            failures.push(
                `function: ${pct.toFixed(1)}% < ${minimums.function}% minimum`,
            );
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
 * Run Node.js coverage gate. Skips when no config entry; always runs the
 * consumer's command — in the repo for fix mode, in a /tmp scratch copy of the
 * git scope for no-fix (read-only verify cannot write a report into the repo)
 * — then validates the report against configured minimums.
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

    // Read-only verify cannot write a report into /repo, so no-fix runs the
    // consumer's command against a scratch copy of the git scope (shared with
    // the dotnet steps via ctx.scratch) and validates the scratch report.
    const { workingRoot, failure } = runCoverageCommand({
        mode: ctx.mode,
        repoRoot: ctx.repoRoot,
        scratch: ctx.scratch,
        trackedFiles,
        command: coverageConfig.command,
        label: "node-coverage",
        runner,
    });
    if (failure !== null) {
        return failure;
    }

    const lcovPath = join(workingRoot, LCOV_PATH);
    if (!existsSync(lcovPath)) {
        return failed({
            notice: `node-coverage: no coverage report at ${LCOV_PATH} — run coverage in a prior step or check command`,
        });
    }

    const content = await readFileFn(lcovPath, "utf8");
    const summary = parseLcov({ content });

    if (summary.linesFound === 0) {
        return failed({
            notice: "node-coverage: lcov report contains no line data",
        });
    }

    const minimums = effectiveMinimums(coverageConfig.minimums);
    const { pass, failures } = checkMinimums({ summary, minimums });

    if (!pass) {
        return failed({
            notice: `node-coverage: ${failures.join("; ")}`,
        });
    }

    const pct = ((summary.linesHit / summary.linesFound) * 100).toFixed(1);
    return passed({
        notice: `node-coverage: ${pct}% line coverage (${summary.linesHit}/${summary.linesFound})`,
    });
}
