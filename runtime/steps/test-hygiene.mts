// steps/test-hygiene.mts — always-on test-hygiene defects over tracked sources.
//
// Tools:    none — the rules live in runtime/lib/test-review/ and travel with
//           the image, so this step needs no consumer dependency, config or
//           cache.
// Fix:      none; every rule reports, nothing repairs, so the step skips the
//           fix pass and judges once in the authoritative no-fix pass.
// Scope:    a scoped step — `.defined.json` `scope.include` narrows the files,
//           exactly as it narrows every other step that judges consumer
//           content.
//
// A defect here is a test that silently does not run, does not assert, or
// cannot fail; the rule catalogue and its tiers live in
// standards/testing/test-review.md, which `defined explain test-hygiene` serves.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
    reviewTestSources,
    type TestReviewSource,
} from "../lib/test-review/rules.mts";
import {
    errored,
    failed,
    passed,
    skipped,
    type StepDiagnostic,
    type StepResult,
} from "../lib/step-result.mts";

/** The suffixes the rule engine can read, by stack. */
export const TEST_HYGIENE_EXTENSIONS = [
    ".ts",
    ".mts",
    ".cts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".jsx",
    ".cs",
    ".yml",
    ".yaml",
] as const;

export interface TestHygieneRunContext {
    /** The step is read-only: it runs in the no-fix verification pass only. */
    mode: "fix" | "no-fix";
    /** Repo root the checkout was mounted at. */
    repoRoot: string;
}

/** Read one source by absolute path. */
type Reader = (path: string) => Promise<string>;

/** The tracked files the engine can read. */
export function filterTestHygieneFiles({
    files,
}: {
    files: string[];
}): string[] {
    return files.filter((file) =>
        (TEST_HYGIENE_EXTENSIONS as readonly string[]).some((extension) =>
            file.endsWith(extension),
        ),
    );
}

/** Read every named source, or the first failure. */
async function readSources({
    repoRoot,
    files,
    reader,
}: {
    repoRoot: string;
    files: string[];
    reader: Reader;
}): Promise<TestReviewSource[] | string> {
    const sources: TestReviewSource[] = [];
    for (const file of files) {
        try {
            sources.push({
                path: file,
                content: await reader(join(repoRoot, file)),
            });
        } catch (err) {
            return `test-hygiene: could not read "${file}": ${
                err instanceof Error ? err.message : String(err)
            }`;
        }
    }
    return sources;
}

/**
 * Run the always-on test-hygiene rules over the tracked sources.
 *
 * @param root0 the parameter object
 * @param root0.ctx the run mode and repo root
 * @param root0.trackedFiles the scoped files to judge
 * @param root0.reviewFiles the `scan --files` list, which replaces the scoped
 *   files when present
 * @param root0.reader source reader, injected so tests need no checkout
 * @returns skip when there is nothing to read, pass when clean, fail with one
 *   diagnostic per finding, or error when a source cannot be read
 */
export async function runTestHygieneStep({
    ctx,
    trackedFiles,
    reviewFiles,
    reader = (path) => readFile(path, "utf8"),
}: {
    ctx: TestHygieneRunContext;
    trackedFiles: string[];
    /** `scan --files` only: exactly the named files, untracked included. */
    reviewFiles?: readonly string[];
    reader?: Reader;
}): Promise<StepResult> {
    if (ctx.mode === "fix") {
        return skipped({
            notice: "test-hygiene: read-only; checked in the verification pass",
        });
    }
    const files =
        reviewFiles === undefined
            ? filterTestHygieneFiles({ files: trackedFiles })
            : [...reviewFiles];
    if (files.length === 0) {
        return skipped({ notice: "test-hygiene: no sources to read" });
    }
    const sources = await readSources({
        repoRoot: ctx.repoRoot,
        files,
        reader,
    });
    if (typeof sources === "string") {
        return errored({ message: sources });
    }
    const findings = reviewTestSources(sources, {
        review: reviewFiles !== undefined,
    });
    if (findings.length === 0) {
        return passed({
            notice: `test-hygiene: ${files.length} file(s) clean`,
        });
    }
    const errors: StepDiagnostic[] = findings.map((finding) => ({
        kind: "finding",
        file: finding.file,
        line: finding.line,
        column: 1,
        rule: finding.rule,
        message: finding.message,
    }));
    return failed({
        notice: `test-hygiene: ${errors.length} finding(s)`,
        errors,
    });
}
