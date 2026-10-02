// Tests for lib/report.mts: the canonical result and its JSON presentations.
// Run: node --test lib/report.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { BOOTSTRAP_CHECK, buildResult, renderResult } from "./report.mts";
import { blocked, errored, failed, passed, skipped } from "./step-result.mts";
import type { SetupCheck } from "../setup.mts";

function cleanSetup(): SetupCheck {
    return {
        files: [
            { name: ".editorconfig", status: "present" },
            { name: "Directory.Build.props", status: "present" },
        ],
        agents: "present",
    };
}

test("buildResult_cleanRun_isCompliantWithEveryCheckResult", () => {
    const result = buildResult({
        setup: cleanSetup(),
        steps: [
            { id: "node", result: passed({}) },
            { id: "eslint", result: skipped({ notice: "no JS/TS" }) },
        ],
    });
    assert.equal(result.status, "compliant");
    assert.deepEqual(result.results, {
        bootstrap: "pass",
        node: "pass",
        eslint: "skip",
    });
    assert.deepEqual(result.errors, []);
});

test("buildResult_failingStep_carriesFindingWithCheckAndMessage", () => {
    const result = buildResult({
        setup: cleanSetup(),
        steps: [
            { id: "node", result: passed({}) },
            { id: "workflow", result: failed({ notice: "actionlint failed" }) },
        ],
    });
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
    const result = buildResult({
        setup: cleanSetup(),
        steps: [{ id: "tofu", result: failed({}) }],
    });
    assert.deepEqual(result.errors, [
        { check: "tofu", kind: "finding", message: "" },
    ]);
});

test("buildResult_errorAndBlockedStatuses_useExecutionAndBlockedKinds", () => {
    const result = buildResult({
        setup: cleanSetup(),
        steps: [
            { id: "node-deps", result: errored({ message: "restore failed" }) },
            { id: "tests", result: blocked({ message: "restore failed" }) },
        ],
    });
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
    const result = buildResult({
        steps: [{ id: "yaml", result: failed({ notice: "yamllint failed" }) }],
    });
    assert.deepEqual(result.results, { yaml: "fail" });
    assert.deepEqual(result.errors, [
        { check: "yaml", kind: "finding", message: "yamllint failed" },
    ]);
});

test("renderResult_full_emitsStatusResultsAndErrorsWhenPresent", () => {
    const result = buildResult({
        steps: [{ id: "node", result: failed({ notice: "prettier failed" }) }],
    });
    assert.equal(
        renderResult({ result, presentation: "full" }),
        '{"status":"not_compliant","results":{"node":"fail"},"errors":[{"check":"node","kind":"finding","message":"prettier failed"}]}',
    );
});

test("renderResult_full_omitsErrorsOnSuccess", () => {
    const result = buildResult({ steps: [{ id: "node", result: passed({}) }] });
    assert.equal(
        renderResult({ result, presentation: "full" }),
        '{"status":"compliant","results":{"node":"pass"}}',
    );
});

test("renderResult_min_successIsJustTheStatus", () => {
    const result = buildResult({ steps: [{ id: "node", result: passed({}) }] });
    assert.equal(
        renderResult({ result, presentation: "min" }),
        '{"status":"compliant"}',
    );
});

test("renderResult_min_failureKeepsEveryDiagnosticAndDropsResults", () => {
    const result = buildResult({
        steps: [
            { id: "eslint", result: failed({ notice: "eslint: 1 finding" }) },
        ],
    });
    assert.equal(
        renderResult({ result, presentation: "min" }),
        '{"status":"not_compliant","errors":[{"check":"eslint","kind":"finding","message":"eslint: 1 finding"}]}',
    );
});

test("renderResult_bothPresentations_agreeOnStatus", () => {
    const clean = buildResult({ steps: [{ id: "node", result: passed({}) }] });
    const dirty = buildResult({
        steps: [{ id: "node", result: failed({ notice: "bad" }) }],
    });
    for (const result of [clean, dirty]) {
        const full = JSON.parse(renderResult({ result, presentation: "full" }));
        const min = JSON.parse(renderResult({ result, presentation: "min" }));
        assert.equal(full.status, min.status);
    }
});

test("renderResult_output_isOneLineWithNoTrailingWhitespace", () => {
    const result = buildResult({
        steps: [{ id: "node", result: failed({ notice: "bad" }) }],
    });
    for (const presentation of ["min", "full"] as const) {
        const line = renderResult({ result, presentation });
        assert.equal(line.includes("\n"), false);
        assert.equal(line, line.trim());
    }
});
