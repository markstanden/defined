// lib/step-result.mts — shared step contract types and constructors.
//
// Every check returns a StepResult. Statuses distinguish a clean pass, a
// skipped (inactive) ecosystem, a tool finding (`fail`), an execution or
// configuration problem (`error`), and a check withheld because a prerequisite
// failed (`blocked`). A step may attach structured diagnostics; report.mts
// owns the canonical envelope and stamps each diagnostic with its check id.

export type StepStatus = "pass" | "fail" | "skip" | "error" | "blocked";

export type DiagnosticKind = "finding" | "execution" | "blocked";

/** A step-scoped diagnostic; the report adds the owning check id. */
export interface StepDiagnostic {
    kind: DiagnosticKind;
    message: string;
    file?: string;
    line?: number;
    column?: number;
    rule?: string;
}

export interface StepResult {
    status: StepStatus;
    notice?: string;
    errors?: StepDiagnostic[];
}

export function passed({ notice }: { notice?: string } = {}): StepResult {
    return { status: "pass", notice };
}

export function failed({
    notice,
    errors,
}: {
    notice?: string;
    errors?: StepDiagnostic[];
} = {}): StepResult {
    return errors
        ? { status: "fail", notice, errors }
        : { status: "fail", notice };
}

/** Skips are clean exits: the ecosystem is absent, nothing was wrong. */
export function skipped({ notice }: { notice: string }): StepResult {
    return { status: "skip", notice };
}

/** The check could not run: a tool/config/execution problem, not a finding. */
export function errored({
    message,
    ...rest
}: { message: string } & Omit<StepDiagnostic, "kind" | "message">): StepResult {
    return {
        status: "error",
        notice: message,
        errors: [{ kind: "execution", message, ...rest }],
    };
}

/** The check did not run because a prerequisite failed. */
export function blocked({ message }: { message: string }): StepResult {
    return {
        status: "blocked",
        notice: message,
        errors: [{ kind: "blocked", message }],
    };
}
