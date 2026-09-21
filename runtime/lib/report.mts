// lib/report.mts — the gate's output contract (decision #24).
//
// Success is exit 0 + exactly one stable `compliant` line (chatter suppressed).
// Failure is non-zero + a stable, agent-actionable breakdown: a status line,
// one `fail` line per failing step, and one per bootstrap finding. The
// breakdown is deliberately line-stable so agents can parse it; step notices
// already carry tool/rule/files and distinguish FIX / REPORT / REVIEW in prose.

import type { SetupCheck } from "../setup.mts";
import type { StepResult } from "./step-result.mts";

export interface ReportedStep {
    id: string;
    result: StepResult;
}

export interface ReportInput {
    verb: "comply" | "verify";
    setup?: SetupCheck;
    steps: ReportedStep[];
}

/** Failing setup artifacts as stable `fail` lines, or [] when clean. */
function setupFailures(setup: SetupCheck): string[] {
    const lines: string[] = [];
    for (const c of setup.files) {
        if (c.status === "absent") {
            lines.push(`fail bootstrap — ${c.name}: absent (run comply)`);
        } else if (c.status === "drift") {
            lines.push(`fail bootstrap — ${c.name}: differs from gate copy`);
        }
    }
    if (setup.agents === "absent") {
        lines.push("fail bootstrap — AGENTS.md: defined block absent");
    } else if (setup.agents === "drift") {
        lines.push("fail bootstrap — AGENTS.md: defined block drifted");
    } else if (setup.agents === "corrupt") {
        lines.push("fail bootstrap — AGENTS.md: defined block corrupt");
    }
    return lines;
}

/**
 * Render the run's output lines. Green runs return exactly `["compliant"]`;
 * anything else returns a stable breakdown with a non-compliant status line
 * first. `comply` marks the status line with `after repair` because it already
 * ran a fix pass.
 */
export function formatReport({ verb, setup, steps }: ReportInput): string[] {
    const failures = setup ? setupFailures(setup) : [];
    for (const s of steps) {
        if (s.result.status === "fail") {
            const notice = s.result.notice ?? "";
            failures.push(`fail ${s.id} — ${notice}`);
        }
    }
    if (failures.length === 0) {
        return ["compliant"];
    }
    const status =
        verb === "comply" ? "not compliant after repair" : "not compliant";
    return [status, ...failures];
}
