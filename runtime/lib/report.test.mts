// Tests for lib/report.mts: the canonical result and its JSON presentations.
// Run: node --test runtime/lib/report.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    BOOTSTRAP_CHECK,
    buildResult,
    mergeRepairErrors,
    renderBusyResult,
    renderResult,
} from "./report.mts";
import { blocked, errored, failed, passed, skipped } from "./step-result.mts";
import type { SetupCheck } from "../setup.mts";

function cleanSetup(): SetupCheck {
    return {
        files: [
            { name: ".editorconfig", status: "present" },
            { name: "Directory.Build.props", status: "present" },
        ],
        agents: "present",
        drift: [],
    };
}

test("buildResult_cleanRun_isCompliantWithEveryCheckResult", () => {
    // Act
    const result = buildResult({
        setup: cleanSetup(),
        steps: [
            { id: "node", result: passed({}) },
            { id: "eslint", result: skipped({ notice: "no JS/TS" }) },
        ],
    });

    // Assert
    assert.equal(result.status, "compliant");
    assert.deepEqual(result.results, {
        bootstrap: "pass",
        node: "pass",
        eslint: "skip",
    });
    assert.deepEqual(result.errors, []);
});

test("buildResult_failingStep_carriesFindingWithCheckAndMessage", () => {
    // Act
    const result = buildResult({
        setup: cleanSetup(),
        steps: [
            { id: "node", result: passed({}) },
            { id: "workflow", result: failed({ notice: "actionlint failed" }) },
        ],
    });

    // Assert
    assert.equal(result.status, "not_compliant");
    assert.equal(result.results.workflow, "fail");
    assert.deepEqual(result.errors, [
        {
            check: "workflow",
            kind: "finding",
            message: "actionlint failed",
        },
    ]);
});

test("buildResult_stepOwnErrors_arePreservedAndStampedWithCheck", () => {
    // Act
    const result = buildResult({
        setup: cleanSetup(),
        steps: [
            {
                id: "eslint",
                result: failed({
                    notice: "eslint: 1 finding",
                    errors: [
                        {
                            kind: "finding",
                            file: "src/parser.ts",
                            line: 42,
                            column: 7,
                            rule: "complexity",
                            message: "Complexity 12 exceeds maximum 10.",
                        },
                    ],
                }),
            },
        ],
    });

    // Assert
    assert.deepEqual(result.errors, [
        {
            check: "eslint",
            kind: "finding",
            file: "src/parser.ts",
            line: 42,
            column: 7,
            rule: "complexity",
            message: "Complexity 12 exceeds maximum 10.",
        },
    ]);
});

test("buildResult_failingStepWithoutNotice_stillEmitsADiagnostic", () => {
    // Act
    const result = buildResult({
        setup: cleanSetup(),
        steps: [{ id: "tofu", result: failed({}) }],
    });

    // Assert
    assert.deepEqual(result.errors, [
        { check: "tofu", kind: "finding", message: "" },
    ]);
});

test("buildResult_errorAndBlockedStatuses_useExecutionAndBlockedKinds", () => {
    // Act
    const result = buildResult({
        setup: cleanSetup(),
        steps: [
            { id: "node-deps", result: errored({ message: "restore failed" }) },
            { id: "tests", result: blocked({ message: "restore failed" }) },
        ],
    });

    // Assert
    assert.equal(result.status, "not_compliant");
    assert.deepEqual(result.results, {
        bootstrap: "pass",
        "node-deps": "error",
        tests: "blocked",
    });
    assert.deepEqual(result.errors, [
        { check: "node-deps", kind: "execution", message: "restore failed" },
        { check: "tests", kind: "blocked", message: "restore failed" },
    ]);
});

test("buildResult_bootstrapAbsenceAndDrift_leadTheErrorsAndFailBootstrap", () => {
    // Act
    const result = buildResult({
        setup: {
            files: [
                { name: ".editorconfig", status: "absent" },
                { name: "Directory.Build.props", status: "drift" },
            ],
            agents: "corrupt",
        },
        steps: [{ id: "node", result: passed({}) }],
    });

    // Assert
    assert.equal(result.results.bootstrap, "fail");
    assert.deepEqual(result.errors, [
        {
            check: BOOTSTRAP_CHECK,
            kind: "finding",
            message: ".editorconfig: absent (run comply)",
            file: ".editorconfig",
        },
        {
            check: BOOTSTRAP_CHECK,
            kind: "finding",
            message: "Directory.Build.props: differs from gate copy",
            file: "Directory.Build.props",
        },
        {
            check: BOOTSTRAP_CHECK,
            kind: "finding",
            message: "AGENTS.md: defined block corrupt",
            file: "AGENTS.md",
        },
    ]);
});

test("buildResult_withoutSetup_reportsOnlyStepResults", () => {
    // Act
    const result = buildResult({
        steps: [{ id: "yaml", result: failed({ notice: "yamllint failed" }) }],
    });

    // Assert
    assert.deepEqual(result.results, { yaml: "fail" });
    assert.deepEqual(result.errors, [
        { check: "yaml", kind: "finding", message: "yamllint failed" },
    ]);
});

test("renderResult_full_emitsStatusResultsAndErrorsWhenPresent", () => {
    // Arrange
    const result = buildResult({
        steps: [{ id: "node", result: failed({ notice: "prettier failed" }) }],
    });

    // Act & Assert
    assert.equal(
        renderResult({ result, presentation: "full" }),
        '{"status":"not_compliant","results":{"node":"fail"},"errors":[{"check":"node","kind":"finding","message":"prettier failed"}]}',
    );
});

test("renderResult_full_omitsErrorsOnSuccess", () => {
    // Arrange
    const result = buildResult({ steps: [{ id: "node", result: passed({}) }] });

    // Act & Assert
    assert.equal(
        renderResult({ result, presentation: "full" }),
        '{"status":"compliant","results":{"node":"pass"}}',
    );
});

test("renderResult_min_successIsJustTheStatus", () => {
    // Arrange
    const result = buildResult({ steps: [{ id: "node", result: passed({}) }] });

    // Act & Assert
    assert.equal(
        renderResult({ result, presentation: "min" }),
        '{"status":"compliant"}',
    );
});

test("renderResult_min_failureKeepsEveryDiagnosticAndDropsResults", () => {
    // Arrange
    const result = buildResult({
        steps: [
            { id: "eslint", result: failed({ notice: "eslint: 1 finding" }) },
        ],
    });

    // Act & Assert
    assert.equal(
        renderResult({ result, presentation: "min" }),
        '{"status":"not_compliant","errors":[{"check":"eslint","kind":"finding","message":"eslint: 1 finding"}]}',
    );
});

test("renderResult_bothPresentations_agreeOnStatus", () => {
    // Arrange
    const clean = buildResult({ steps: [{ id: "node", result: passed({}) }] });
    const dirty = buildResult({
        steps: [{ id: "node", result: failed({ notice: "bad" }) }],
    });
    for (const result of [clean, dirty]) {
        // Act & Assert — both presentations agree on the status.
        const full = JSON.parse(renderResult({ result, presentation: "full" }));
        const min = JSON.parse(renderResult({ result, presentation: "min" }));
        assert.equal(full.status, min.status);
    }
});

test("renderResult_output_isOneLineWithNoTrailingWhitespace", () => {
    // Arrange
    const result = buildResult({
        steps: [{ id: "node", result: failed({ notice: "bad" }) }],
    });
    for (const presentation of ["min", "full"] as const) {
        // Act & Assert — every rendering is one trimmed line.
        const line = renderResult({ result, presentation });
        assert.equal(line.includes("\n"), false);
        assert.equal(line, line.trim());
    }
});

test("mergeRepairErrors_preservesARepairErrorVerifyReadsClean", () => {
    // Arrange
    const repair = new Map([
        ["node", errored({ message: "prettier --write failed" })],
    ]);
    const verify = new Map([
        ["node", passed({ notice: "formatted" })],
        ["shell", passed({})],
    ]);

    // Act
    const steps = mergeRepairErrors({ repair, verify });
    const node = steps.find((step) => step.id === "node")!;

    // Assert
    assert.equal(node.result.status, "error");
    assert.equal(node.result.notice, "prettier --write failed");
    // Verification's other steps are untouched.
    assert.equal(
        steps.find((step) => step.id === "shell")!.result.status,
        "pass",
    );
});

test("mergeRepairErrors_keepsTheAuthoritativeVerifyResultWhenItAlsoFailed", () => {
    // Arrange
    const repair = new Map([["node", failed({ notice: "fix left diffs" })]]);
    const verify = new Map([["node", failed({ notice: "still unformatted" })]]);

    // Act
    const steps = mergeRepairErrors({ repair, verify });

    // Assert
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.result.notice, "still unformatted");
});

test("mergeRepairErrors_ignoresPassingAndSkippedRepairSteps", () => {
    // Arrange
    const repair = new Map([
        ["node", passed({})],
        ["yaml", skipped({ notice: "deferred to verification" })],
        ["coverage", skipped({ notice: "deferred" })],
    ]);
    const verify = new Map([
        ["node", passed({})],
        ["yaml", passed({})],
        ["coverage", passed({})],
    ]);

    // Act
    const steps = mergeRepairErrors({ repair, verify });

    // Assert
    assert.deepEqual(
        steps.map((step) => [step.id, step.result.status]),
        [
            ["node", "pass"],
            ["yaml", "pass"],
            ["coverage", "pass"],
        ],
    );
});

test("mergeRepairErrors_addsARepairStepVerifyDidNotRun", () => {
    // Arrange
    const repair = new Map([
        ["shell", errored({ message: "shfmt -w failed" })],
    ]);
    const verify = new Map([["node", passed({})]]);

    // Act
    const steps = mergeRepairErrors({ repair, verify });

    // Assert
    assert.deepEqual(
        steps.map((step) => [step.id, step.result.status]),
        [
            ["node", "pass"],
            ["shell", "error"],
        ],
    );
});

test("renderBusyResult_isTheThirdStatusWithTheHolderAndStaleEdits", () => {
    // Act & Assert
    assert.equal(
        renderBusyResult({
            lock: {
                pid: 99,
                startedAt: "2026-10-04T00:00:00.000Z",
                checkout: "/repo",
                command: "comply",
            },
            newerThanRun: ["src/a.ts"],
        }),
        '{"status":"busy","lock":{"pid":99,"startedAt":"2026-10-04T00:00:00.000Z","checkout":"/repo","command":"comply"},"newerThanRun":["src/a.ts"]}',
    );
});

const WEAKENED = {
    kind: "config" as const,
    message: "eslint.disable: disables the house ESLint floor",
    file: ".defined.json",
};

test("buildResult_advisoryDrift_keepsCompliantAndCarriesNotices", () => {
    // Arrange
    const setup = { ...cleanSetup(), drift: [WEAKENED] };

    // Act
    const result = buildResult({
        setup,
        steps: [{ id: "node", result: passed({}) }],
    });

    // Assert
    assert.equal(result.status, "compliant");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.notices, [WEAKENED]);
});

test("renderResult_minPresentation_advisoryDrift_isVisibleWithoutErrors", () => {
    // Arrange
    const result = buildResult({
        setup: { ...cleanSetup(), drift: [WEAKENED] },
        steps: [{ id: "node", result: passed({}) }],
    });

    // Act
    const rendered = JSON.parse(renderResult({ result, presentation: "min" }));

    // Assert
    assert.equal(rendered.status, "compliant");
    assert.deepEqual(rendered.notices, [WEAKENED]);
    assert.equal("errors" in rendered, false);
});

test("renderResult_fullPresentation_advisoryDrift_sitsBesideResults", () => {
    // Arrange
    const result = buildResult({
        setup: { ...cleanSetup(), drift: [WEAKENED] },
        steps: [{ id: "node", result: passed({}) }],
    });

    // Act
    const rendered = JSON.parse(renderResult({ result, presentation: "full" }));

    // Assert
    assert.deepEqual(rendered.notices, [WEAKENED]);
    assert.equal(rendered.results.bootstrap, "pass");
});

test("renderResult_cleanSetup_omitsTheNoticesKey", () => {
    // Arrange
    const result = buildResult({
        setup: cleanSetup(),
        steps: [{ id: "node", result: passed({}) }],
    });

    // Act
    const rendered = renderResult({ result, presentation: "min" });

    // Assert
    assert.equal(rendered, '{"status":"compliant"}');
});
