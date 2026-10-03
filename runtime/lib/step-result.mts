// lib/step-result.mts — shared step contract types and constructors.
//
// Every check returns a StepResult. Statuses distinguish a clean pass, a
// skipped (inactive) ecosystem, a tool finding (`fail`), an execution or
// configuration problem (`error`), and a check withheld because a prerequisite
// failed (`blocked`). A step may attach structured diagnostics; report.mts
// owns the canonical envelope and stamps each diagnostic with its check id.

export type StepStatus = "pass" | "fail" | "skip" | "error" | "blocked";

/** The `DiagnosticKind` a step may emit. */
export type DiagnosticKind = "finding" | "execution" | "blocked";

/** A step-scoped diagnostic; the report adds the owning check id. */
export interface StepDiagnostic {
    /** Finding (lint/tool result), execution failure, or blocked dependency. */
    kind: DiagnosticKind;
    /** Human-readable, single-phrase description of the problem. */
    message: string;
    /** Repo-relative file the diagnostic points at, when known. */
    file?: string;
    /** 1-based line, where the tool reports one; else 0. */
    line?: number;
    /** 1-based column, where the tool reports one; else 0. */
    column?: number;
    /** The rule id (shellcheck/yamllint/eslint), when the tool names one. */
    rule?: string;
}

export interface StepResult {
    /** Terminal status after the pass: pass/fail/skip/error/blocked. */
    status: StepStatus;
    /** One-line summary for the report notice, when the step carries text. */
    notice?: string;
    /** Per-rule diagnostics; present when the step has something to name. */
    errors?: StepDiagnostic[];
}

/**
 * Report a clean pass.
 *
 * @param root0 the parameter object
 * @param root0.notice optional one-line summary (see StepResult's contract)
 */
export function passed({ notice }: { notice?: string } = {}): StepResult {
    return { status: "pass", notice };
}

/**
 * Report a failed check, optionally naming per-rule diagnostics.
 *
 * @param root0 the parameter object
 * @param root0.notice optional one-line summary (see StepResult's contract)
 * @param root0.errors diagnostics; present with the step names rules/files
 */
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
