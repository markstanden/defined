// lib/report.mts — the gate's canonical result and JSON output contract (#72).
//
// One canonical GateResult is assembled from the bootstrap check and the step
// results, then rendered for a presentation. Every presentation always carries
// `status`, and carries `errors` whenever any occurred:
//
//   full  { "status": …, "results": { … }, "errors": [ … ] }
//   min   { "status": … }                      (errors added when present)
//
// `min` is the default: it drops the per-check `results` map while keeping every
// diagnostic. `full` opts into the map — useful for one contextual run, noise
// thereafter. The process exit code derives from `status` — never from the
// rendered text — so both presentations agree by construction.

import type { SetupCheck } from "../setup.mts";
import type {
    DiagnosticKind,
    StepDiagnostic,
    StepResult,
    StepStatus,
} from "./step-result.mts";

/** How much of the canonical result to render. */
export type Presentation = "min" | "full";

export type ResultStatus = "compliant" | "not_compliant";

export interface ReportedStep {
    id: string;
    result: StepResult;
}

export interface ReportInput {
    setup?: SetupCheck;
    steps: ReportedStep[];
}

/** A diagnostic carrying the check that produced it. */
export interface Diagnostic {
    check: string;
    kind: DiagnosticKind;
    message: string;
    file?: string;
    line?: number;
    column?: number;
    rule?: string;
}

export interface GateResult {
    status: ResultStatus;
    results: Record<string, StepStatus>;
    errors: Diagnostic[];
}

const UNSUCCESSFUL: ReadonlySet<StepStatus> = new Set([
    "fail",
    "error",
    "blocked",
]);

/** The synthetic check id for gate-owned bootstrap artefacts. */
export const BOOTSTRAP_CHECK = "bootstrap";

/** Bootstrap artefacts as diagnostics; [] when every artefact is in line. */
function bootstrapErrors(setup: SetupCheck): Diagnostic[] {
    const errors: Diagnostic[] = [];
    for (const c of setup.files) {
        if (c.status === "absent") {
            errors.push({
                check: BOOTSTRAP_CHECK,
                kind: "finding",
                message: `${c.name}: absent (run comply)`,
                file: c.name,
            });
        } else if (c.status === "drift") {
            errors.push({
                check: BOOTSTRAP_CHECK,
                kind: "finding",
                message: `${c.name}: differs from gate copy`,
                file: c.name,
            });
        }
    }
    if (setup.agents === "absent") {
        errors.push({
            check: BOOTSTRAP_CHECK,
            kind: "finding",
            message: "AGENTS.md: defined block absent",
            file: "AGENTS.md",
        });
    } else if (setup.agents === "drift") {
        errors.push({
            check: BOOTSTRAP_CHECK,
            kind: "finding",
            message: "AGENTS.md: defined block drifted",
            file: "AGENTS.md",
        });
    } else if (setup.agents === "corrupt") {
        errors.push({
            check: BOOTSTRAP_CHECK,
            kind: "finding",
            message: "AGENTS.md: defined block corrupt",
            file: "AGENTS.md",
        });
    }
    return errors;
}

/** A failing step's diagnostics: its own, else one synthesised from its notice. */
function stepErrors({ id, result }: ReportedStep): Diagnostic[] {
    if (!UNSUCCESSFUL.has(result.status)) {
        return [];
    }
    const fallbackKind: DiagnosticKind =
        result.status === "blocked" ? "blocked" : "finding";
    const own: StepDiagnostic[] =
        result.errors && result.errors.length > 0
            ? result.errors
            : [{ kind: fallbackKind, message: result.notice ?? "" }];
    return own.map((error) => ({ check: id, ...error }));
}

/**
 * Fold the repair pass into the authoritative verification steps (#65).
 *
 * Verification decides the verdict. But a repair step that did not pass must
 * not vanish behind a verification pass that reads clean — a fixer that
 * errored or failed while mutating is preserved, promoting that check to the
 * repair result. When verification already reports the check as unsuccessful,
 * its (authoritative) result stands and the repair result is not duplicated.
 */
export function mergeRepairErrors({
    repair,
    verify,
}: {
    repair: Map<string, StepResult>;
    verify: Map<string, StepResult>;
}): ReportedStep[] {
    const steps: ReportedStep[] = [...verify].map(([id, result]) => ({
        id,
        result,
    }));
    for (const [id, result] of repair) {
        if (!UNSUCCESSFUL.has(result.status)) {
            continue;
        }
        const verified = verify.get(id);
        if (verified !== undefined && UNSUCCESSFUL.has(verified.status)) {
            continue;
        }
        const existing = steps.find((step) => step.id === id);
        if (existing) {
            existing.result = result;
        } else {
            steps.push({ id, result });
        }
    }
    return steps;
}

/**
 * Assemble the canonical result: every check's status plus actionable
 * diagnostics. `bootstrap` leads the results when a setup check is supplied.
 */
export function buildResult({ setup, steps }: ReportInput): GateResult {
    const results: Record<string, StepStatus> = {};
    const errors: Diagnostic[] = [];
    if (setup) {
        const bootstrap = bootstrapErrors(setup);
        results[BOOTSTRAP_CHECK] = bootstrap.length > 0 ? "fail" : "pass";
        errors.push(...bootstrap);
    }
    for (const step of steps) {
        results[step.id] = step.result.status;
        errors.push(...stepErrors(step));
    }
    return {
        status: errors.length > 0 ? "not_compliant" : "compliant",
        results,
        errors,
    };
}

/** Render the canonical result as one compact JSON line for a presentation. */
export function renderResult({
    result,
    presentation,
}: {
    result: GateResult;
    presentation: Presentation;
}): string {
    const { status, results, errors } = result;
    const withErrors = errors.length > 0 ? { errors } : {};
    return JSON.stringify(
        presentation === "full"
            ? { status, results, ...withErrors }
            : { status, ...withErrors },
    );
}
