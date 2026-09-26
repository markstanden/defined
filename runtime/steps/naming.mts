// steps/naming.mts — semantic naming conventions.
//
// Tools:    none built in beyond the workflow-filename grammar; an optional
//           consumer-supplied rules command (`.defined.json` "naming") runs
//           over the repo's git scope.
// Config:   .defined.json at repo root, "naming" key — raises-only
// Fix:      an optional "naming.fix" command runs first in fix mode, then the
//           rules command always re-runs before reporting.
// No-fix:   a declared rules command runs against a /tmp scratch copy of the
//           git scope (a read-only verify cannot write there), shared with the
//           coverage steps via ctx.scratch.
// Skip:     no workflow files and no consumer rules declared.
//
// Two things are enforced:
//   1. The gate's own documented workflow-filename grammar
//      (`<namespace>--<loose-verb>[--<target>].yml`, standards/naming.md) over
//      tracked `.github/workflows/*.yml|yaml` files — always, when they exist.
//   2. The consumer's rules command, when declared, over the git scope. The
//      gate provides the framework; projects bring their own doctrine.
// The runner is injected so tests need no host binaries.

import { basename } from "node:path";

import {
    failed,
    passed,
    skipped,
    type StepResult,
} from "../lib/step-result.mts";
import { runScopedCommand } from "../lib/coverage.mts";
import type { Scratch } from "../lib/scratch.mts";
import { run } from "../../lib/proc.mts";
import { loadConfig } from "../lib/config.mts";
import { filterWorkflowFiles } from "../lib/workflow-files.mts";

export interface NamingRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
    /** Shared scratch box (no-fix): one copy serves the write-capable steps. */
    scratch?: Scratch;
}

type Runner = typeof run;

/**
 * Workflow filename grammar (standards/naming.md):
 * `<namespace>--<loose-verb>[--<target>].yml`. `--` separates the segments and
 * `-` joins words within a segment, so a `--` inside a segment is impossible by
 * construction. `.yaml` is accepted alongside `.yml`.
 */
const SEGMENT = `[a-z0-9]+(?:-[a-z0-9]+)*`;
export const WORKFLOW_NAME_RE = new RegExp(
    String.raw`^${SEGMENT}--${SEGMENT}(?:--${SEGMENT})?\.ya?ml$`,
    "u",
);

/** True when a workflow filename matches the documented grammar. */
export function isValidWorkflowName({ name }: { name: string }): boolean {
    return WORKFLOW_NAME_RE.test(name);
}

/** Tracked workflow files whose names break the grammar, in input order. */
export function workflowNameViolations({
    files,
}: {
    files: string[];
}): string[] {
    return filterWorkflowFiles({ files }).filter(
        (file) => !isValidWorkflowName({ name: basename(file) }),
    );
}

/**
 * Run the naming step: enforce the workflow-filename grammar over tracked
 * workflow files and, when declared, the consumer's rules command. Returns skip
 * when there is nothing to check; fail naming every violation.
 */
export async function runNamingStep({
    ctx,
    trackedFiles,
    runner = run,
    readFileFn,
}: {
    ctx: NamingRunContext;
    trackedFiles: string[];
    runner?: Runner;
    readFileFn?: typeof import("node:fs/promises").readFile;
}): Promise<StepResult> {
    const config = await loadConfig({ repoRoot: ctx.repoRoot, readFileFn });
    const naming = config.naming;

    const violations = workflowNameViolations({ files: trackedFiles });
    const checked = filterWorkflowFiles({ files: trackedFiles }).length;
    if (
        violations.length === 0 &&
        checked === 0 &&
        naming?.command === undefined
    ) {
        return skipped({
            notice: "naming: no workflow files and no rules declared",
        });
    }

    const failures: string[] = [];
    for (const file of violations) {
        failures.push(
            `${file}: filename must match <namespace>--<verb>[--<target>].yml`,
        );
    }

    if (naming?.command !== undefined) {
        if (ctx.mode === "fix" && naming.fix !== undefined) {
            const fix = runScopedCommand({
                mode: ctx.mode,
                repoRoot: ctx.repoRoot,
                scratch: ctx.scratch,
                trackedFiles,
                command: naming.fix,
                runner,
            });
            if (fix.failure !== null) {
                failures.push(`autofix failed: ${fix.failure}`);
            }
        }
        const check = runScopedCommand({
            mode: ctx.mode,
            repoRoot: ctx.repoRoot,
            scratch: ctx.scratch,
            trackedFiles,
            command: naming.command,
            runner,
        });
        if (check.failure !== null) {
            failures.push(`rules failed: ${check.failure}`);
        }
    }

    if (failures.length > 0) {
        return failed({ notice: `naming: ${failures.join("; ")}` });
    }
    const rules = naming?.command !== undefined ? "; consumer rules clean" : "";
    return passed({
        notice: `naming: ${checked} workflow name(s) valid${rules}`,
    });
}
