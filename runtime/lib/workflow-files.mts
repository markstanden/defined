// lib/workflow-files.mts — the gate's two views of .github/ YAML (issue #42).
//
// Two distinct sets are needed, and used to be duplicated between steps/naming
// and steps/workflow with *different* semantics — a genuine footgun:
//
// - filterWorkflowFiles — workflow *definitions* under .github/workflows/. The
//   naming grammar applies to these, and actionlint may only parse these:
//   handed .github/dependabot.yml it treats it as a workflow and false-fails
//   ("jobs section is missing in workflow").
// - filterWorkflowAuditFiles — the audit set: workflow definitions plus
//   .github/dependabot.yml. zizmor audits both (its dependabot-cooldown
//   findings live there); it is not a workflow parser and accepts the extra
//   file.
// - filterFixableFiles — the audit set minus the gate-managed workflow: what a
//   zizmor autofix may rewrite. The managed file belongs to the gate and is
//   repaired upstream, never by a consumer-side autofix.
//
// One source of truth so the views can never drift apart again.

/** Workflow definitions under .github/workflows/ (never dependabot.yml). */
export function filterWorkflowFiles({ files }: { files: string[] }): string[] {
    return files.filter(
        (file) =>
            file.startsWith(".github/workflows/") &&
            (file.endsWith(".yml") || file.endsWith(".yaml")),
    );
}

/** The audit set zizmor sees: workflow definitions plus .github/dependabot.yml. */
export function filterWorkflowAuditFiles({
    files,
}: {
    files: string[];
}): string[] {
    return files.filter(
        (file) =>
            (file.startsWith(".github/workflows/") &&
                (file.endsWith(".yml") || file.endsWith(".yaml"))) ||
            file === ".github/dependabot.yml",
    );
}

/**
 * The gate-managed gate workflow: gate-owned plumbing that must stay
 * byte-identical to the image (installManagedFiles/checkManagedFiles enforce
 * it). Single source of truth — setup.mts installs it and the workflow step's
 * fixer excludes it.
 */
export const MANAGED_WORKFLOW_FILE = ".github/workflows/defined--verify.yml";

/**
 * The audit set minus the gate-managed workflow: the files a zizmor autofix
 * may rewrite. The managed file is repaired upstream in the gate, never in a
 * consumer's working tree, so an autofix must leave it alone.
 */
export function filterFixableFiles({ files }: { files: string[] }): string[] {
    return filterWorkflowAuditFiles({ files }).filter(
        (file) => file !== MANAGED_WORKFLOW_FILE,
    );
}
