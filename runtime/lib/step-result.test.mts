// Tests for lib/step-result.mts: the shared step-result constructors.
// Run: node --test runtime/lib/step-result.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { blocked, errored, failed, passed, skipped } from "./step-result.mts";

test("passed_carriesPassWithOptionalNotice", () => {
    // Act & Assert — bare, then with a notice.
    assert.deepEqual(passed({}), { status: "pass", notice: undefined });
    assert.deepEqual(passed({ notice: "ok" }), {
        status: "pass",
        notice: "ok",
    });
});

test("failed_carriesFailAndAnyDiagnostics", () => {
    // Act & Assert — a bare failure.
    assert.deepEqual(failed({}), { status: "fail", notice: undefined });

    // Act — a failure with a notice and one diagnostic.
    const result = failed({
        notice: "eslint: 1 finding",
        errors: [{ kind: "finding", message: "complexity" }],
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.deepEqual(result.errors, [
        { kind: "finding", message: "complexity" },
    ]);
});

test("skipped_requiresANotice", () => {
    // Act & Assert
    assert.deepEqual(skipped({ notice: "no scripts" }), {
        status: "skip",
        notice: "no scripts",
    });
});

test("errored_isAnExecutionDiagnosticNotAFinding", () => {
    // Act & Assert
    assert.deepEqual(errored({ message: "restore failed" }), {
        status: "error",
        notice: "restore failed",
        errors: [{ kind: "execution", message: "restore failed" }],
    });
});

test("errored_forwardsLocationFields", () => {
    // Act & Assert
    assert.deepEqual(
        errored({ message: "bad config", file: ".eslintrc", line: 3 }),
        {
            status: "error",
            notice: "bad config",
            errors: [
                {
                    kind: "execution",
                    message: "bad config",
                    file: ".eslintrc",
                    line: 3,
                },
            ],
        },
    );
});

test("blocked_isABlockedDiagnostic", () => {
    // Act & Assert
    assert.deepEqual(blocked({ message: "restore failed" }), {
        status: "blocked",
        notice: "restore failed",
        errors: [{ kind: "blocked", message: "restore failed" }],
    });
});
