// Tests for lib/report.mts: the gate's stable output contract.
// Run: node --test lib/report.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatReport } from "./report.mts";
import { failed, passed, skipped } from "./step-result.mts";
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

test("green run yields exactly one stable compliant line", () => {
    const lines = formatReport({
        verb: "verify",
        setup: cleanSetup(),
        steps: [
            { id: "node", result: passed({}) },
            { id: "shell", result: skipped({ notice: "no scripts" }) },
        ],
    });
    assert.deepEqual(lines, ["compliant"]);
});

test("verify failure lists the status line then each failing step", () => {
    const lines = formatReport({
        verb: "verify",
        setup: cleanSetup(),
        steps: [
            { id: "node", result: passed({}) },
            { id: "workflow", result: failed({ notice: "actionlint failed" }) },
        ],
    });
    assert.deepEqual(lines, [
        "not compliant",
        "fail workflow — actionlint failed",
    ]);
});

test("comply failure marks the status line after repair", () => {
    const lines = formatReport({
        verb: "comply",
        setup: cleanSetup(),
        steps: [{ id: "node", result: failed({ notice: "prettier failed" }) }],
    });
    assert.deepEqual(lines, [
        "not compliant after repair",
        "fail node — prettier failed",
    ]);
});

test("bootstrap absence and drift are agent-actionable fail lines", () => {
    const lines = formatReport({
        verb: "verify",
        setup: {
            files: [
                { name: ".editorconfig", status: "absent" },
                { name: "Directory.Build.props", status: "drift" },
            ],
            agents: "corrupt",
        },
        steps: [],
    });
    assert.deepEqual(lines, [
        "not compliant",
        "fail bootstrap — .editorconfig: absent (run comply)",
        "fail bootstrap — Directory.Build.props: differs from gate copy",
        "fail bootstrap — AGENTS.md: defined block corrupt",
    ]);
});

test("step failure without a notice still lists the step", () => {
    const lines = formatReport({
        verb: "verify",
        setup: cleanSetup(),
        steps: [{ id: "tofu", result: failed({}) }],
    });
    assert.deepEqual(lines, ["not compliant", "fail tofu — "]);
});

test("verify without a setup check reports only step failures", () => {
    const lines = formatReport({
        verb: "verify",
        steps: [{ id: "yaml", result: failed({ notice: "yamllint failed" }) }],
    });
    assert.deepEqual(lines, ["not compliant", "fail yaml — yamllint failed"]);
});
