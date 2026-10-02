// steps/yaml.mts — YAML lint via yamllint over tracked YAML files.
//
// Tools:    yamllint (check only — no autofix exists; formatting of YAML
//           is prettier's job once the node step lands)
// Config:   runtime/config/yamllint.yml, passed explicitly (-c) so it
//           travels with the gate regardless of CWD (prototype lesson:
//           yamllint resolves config relative to CWD unless told).
//           Runs with -s: warnings are failures, so the bar is identical
//           locally and in CI.
// Fix:      none; the step is check-only, so repair skips it and it runs once
//           in the authoritative no-fix pass (#65)
//
// Detection is data-driven: the orchestrator supplies tracked files. The
// runner is injected so tests need no host binaries.

import {
    failed,
    passed,
    skipped,
    type StepDiagnostic,
    type StepResult,
} from "../lib/step-result.mts";
import { run } from "../../lib/proc.mts";
import { gateConfigPath } from "../lib/config-path.mts";

export const YAML_EXTENSIONS = [".yml", ".yaml"] as const;

export interface YamlRunContext {
    mode: "fix" | "no-fix";
}

type Runner = typeof run;

export function filterYamlFiles({ files }: { files: string[] }): string[] {
    return files.filter((file) =>
        (YAML_EXTENSIONS as readonly string[]).some((ext) =>
            file.endsWith(ext),
        ),
    );
}

// yamllint's parsable format: `file:line:col: [level] message (rule)`. The
// level brackets are present in some versions, absent in others.
const YAMLLINT_LINE =
    /^(.+?):(\d+):(\d+): \[?([a-z]+)\]? (.*?)(?: \(([^)]+)\))?$/u;

/** Every yamllint finding as a structured diagnostic. */
export function parseYamllint({
    stdout,
}: {
    stdout: string;
}): StepDiagnostic[] {
    const errors: StepDiagnostic[] = [];
    for (const raw of stdout.split("\n")) {
        const match = YAMLLINT_LINE.exec(raw.trim());
        if (match === null) {
            continue;
        }
        errors.push({
            kind: "finding",
            file: match[1]!,
            line: Number(match[2]),
            column: Number(match[3]),
            rule: match[6] ?? "yamllint",
            message: match[5]!,
        });
    }
    return errors;
}

/**
 * Run yamllint over tracked YAML files using the gate's travelling config.
 * Returns skip when no YAML exists; fail naming violation count otherwise.
 */
export async function runYamlStep({
    ctx,
    trackedFiles,
    runner = run,
}: {
    ctx: YamlRunContext;
    trackedFiles: string[];
    runner?: Runner;
}): Promise<StepResult> {
    const files = filterYamlFiles({ files: trackedFiles });
    if (files.length === 0) {
        return skipped({ notice: "yaml: no tracked *.yml/*.yaml files" });
    }

    // Repair (#65): yamllint has no autofix — a check-only task, so it runs
    // once, in the authoritative no-fix pass.
    if (ctx.mode === "fix") {
        return skipped({ notice: "yaml: deferred to verification" });
    }

    // -f parsable gives one finding per line, machine-countable.
    // -s makes warnings failures too: the same bar locally and in CI.
    // Config resolves from the gate's own directory (lib/paths.mts), never
    // the CWD — consumer repos have no runtime/ of their own.
    const result = runner({
        cmd: "yamllint",
        args: [
            "-c",
            await gateConfigPath({ name: "yamllint.yml" }),
            "-s",
            "-f",
            "parsable",
            ...files,
        ],
    });
    if (result.status !== 0) {
        const errors = parseYamllint({ stdout: result.stdout });
        if (errors.length === 0) {
            return failed({
                notice: `yaml: yamllint failed: ${
                    result.stderr.trim() || result.stdout.trim()
                }`,
            });
        }
        return failed({
            notice: `yaml: ${errors.length} yamllint finding(s)`,
            errors,
        });
    }

    return passed({ notice: `yaml: ${files.length} file(s) clean` });
}
