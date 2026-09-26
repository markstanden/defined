// Tests for lib/workflow-files.mts: the workflow-only and audit views.
// Run: node --test lib/workflow-files.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    filterWorkflowAuditFiles,
    filterWorkflowFiles,
} from "./workflow-files.mts";

const FILES = [
    ".github/workflows/ci.yml",
    ".github/dependabot.yml",
    ".github/workflows/cd.yaml",
    ".github/other.yml",
    "a.sh",
];

test("filterWorkflowFiles keeps only .github/workflows yml/yaml", () => {
    assert.deepEqual(filterWorkflowFiles({ files: FILES }), [
        ".github/workflows/ci.yml",
        ".github/workflows/cd.yaml",
    ]);
});

test("filterWorkflowAuditFiles adds dependabot.yml to the workflow set", () => {
    assert.deepEqual(filterWorkflowAuditFiles({ files: FILES }), [
        ".github/workflows/ci.yml",
        ".github/dependabot.yml",
        ".github/workflows/cd.yaml",
    ]);
});
