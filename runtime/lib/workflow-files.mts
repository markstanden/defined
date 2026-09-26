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
//
// One source of truth so the two views can never drift apart again.

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
