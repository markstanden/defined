// steps/naming.mts — semantic naming conventions.
//
// Tools:    none built in beyond the workflow-filename grammar; an optional
//           consumer-supplied rules command (`.defined.json` "naming") runs
//           over the repo's git scope.
// Config:   .defined.json at repo root, "naming" key — raises-only
// Fix:      the optional "naming.fix" command only. This is the repair pass
//           (#65): the workflow-filename grammar and the rules command run once
//           in the authoritative no-fix verification pass.
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
import { loadConfig, type NamingConfig } from "../lib/config.mts";
import { filterWorkflowFiles } from "../lib/workflow-files.mts";

export interface NamingRunContext {
    /** Repair (fix) or authoritative verification (no-fix) — see comply #65. */
    mode: "fix" | "no-fix";
    /** Repo root the checkout was mounted at; scratch copies hang off it. */
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
 * Repair (fix, #65): the only mutation is the consumer's autofix command. The
 * filename grammar and the rules command are verification, run once in the
 * authoritative no-fix pass. Returns skip when the consumer declared no autofix.
 */
async function runNamingRepair({
    ctx,
    naming,
    trackedFiles,
    runner,
}: {
    ctx: NamingRunContext;
    naming: NamingConfig | undefined;
    trackedFiles: string[];
    runner: Runner;
}): Promise<StepResult> {
    if (naming?.fix === undefined) {
        return skipped({ notice: "naming: no consumer autofix declared" });
    }
    const fix = await runScopedCommand({
        mode: ctx.mode,
        repoRoot: ctx.repoRoot,
        scratch: ctx.scratch,
        trackedFiles,
        command: naming.fix,
        runner,
    });
    if (fix.failure !== null) {
        return failed({ notice: `naming: autofix failed: ${fix.failure}` });
    }
    return passed({ notice: "naming: applied consumer autofix" });
}

/**
 * Run the consumer's rules check over the git scope, appending a failure line
 * when it breaks. Verification only.
 */
async function runConsumerRules({
    ctx,
    naming,
    trackedFiles,
    runner,
    failures,
}: {
    ctx: NamingRunContext;
    naming: NamingConfig;
    trackedFiles: string[];
    runner: Runner;
    failures: string[];
}): Promise<void> {
    const check = await runScopedCommand({
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

/** The step verdict: every failure, or the clean-pass notice. */
function namingVerdict({
    checked,
    hasRules,
    failures,
}: {
    checked: number;
    hasRules: boolean;
    failures: string[];
}): StepResult {
    if (failures.length > 0) {
        return failed({ notice: `naming: ${failures.join("; ")}` });
    }
    const rules = hasRules ? "; consumer rules clean" : "";
    return passed({
        notice: `naming: ${checked} workflow name(s) valid${rules}`,
    });
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

    // Repair (#65): mutate only — the consumer autofix. The filename grammar
    // and the rules check are verification.
    if (ctx.mode === "fix") {
        return runNamingRepair({ ctx, naming, trackedFiles, runner });
    }

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

    const failures = violations.map(
        (file) =>
            `${file}: filename must match <namespace>--<verb>[--<target>].yml`,
    );
    if (naming?.command !== undefined) {
        await runConsumerRules({
            ctx,
            naming,
            trackedFiles,
            runner,
            failures,
        });
    }
    return namingVerdict({
        checked,
        hasRules: naming?.command !== undefined,
        failures,
    });
}
