// Tests for steps/workflow.mts: actionlint + zizmor + gitleaks.
// Runner injected; no host binaries needed.
// Run: node --test steps/workflow.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    buildGitleaksConfig,
    escapeRegexPath,
    filterWorkflowFiles,
    parseIgnoredPaths,
    runWorkflowStep,
} from "./workflow.mts";
import { baseCtx, fakeRunner } from "../test-helpers.mts";

test("filterWorkflowFiles finds .github/workflows/*.yml and dependabot.yml", () => {
    assert.deepEqual(
        filterWorkflowFiles({
            files: [
                ".github/workflows/ci.yml",
                ".github/dependabot.yml",
                ".github/workflows/cd.yaml",
                "a.sh",
            ],
        }),
        [
            ".github/workflows/ci.yml",
            ".github/dependabot.yml",
            ".github/workflows/cd.yaml",
        ],
    );
});

test("filterWorkflowFiles ignores non-workflow yaml in .github/", () => {
    assert.deepEqual(
        filterWorkflowFiles({
            files: [".github/other.yml", ".github/workflows/ci.yml"],
        }),
        [".github/workflows/ci.yml"],
    );
});

test("runWorkflowStep skips actionlint/zizmor when no workflow files", async () => {
    const { runner, calls } = fakeRunner({}, true);
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: ["a.sh", "b.yml"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.ok((result.notice ?? "").includes("no workflow files"));
    // git status --ignored runs first, then gitleaks still scans the tree
    assert.deepEqual(
        calls.map((c) => c[0]),
        ["git", "gitleaks"],
    );
});

test("actionlint runs on workflow files, then zizmor, then gitleaks", async () => {
    const { runner, calls } = fakeRunner({}, true);
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });
    assert.equal(result.status, "pass");
    const cmds = calls.map((c) => c[0]);
    assert.deepEqual(cmds, ["actionlint", "zizmor", "git", "gitleaks"]);
    // actionlint gets the file as first arg
    assert.deepEqual(calls[0]!.slice(1, 2), [".github/workflows/ci.yml"]);
    // zizmor gets --no-progress as first arg
    assert.equal(calls[1]![1], "--no-progress");
    // git status --ignored gets --porcelain
    assert.deepEqual(calls[2]!.slice(1, 3), ["status", "--porcelain"]);
    // gitleaks gets "dir --config <temp>" and "." last
    assert.equal(calls[3]![1], "dir");
    assert.equal(calls[3]![2], "--config");
    assert.match(calls[3]![3]!, /defined-gitleaks\.toml$/u);
    assert.equal(calls[3]![4], ".");
});

test("actionlint failure fails the step", async () => {
    const { runner } = fakeRunner(
        { actionlint: { status: 1, stderr: "actionlint error" } },
        true,
    );
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("actionlint"));
});

test("zizmor failure fails the step", async () => {
    const { runner } = fakeRunner(
        { zizmor: { status: 1, stderr: "zizmor error" } },
        true,
    );
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("zizmor"));
});

test("gitleaks failure fails the step", async () => {
    const { runner } = fakeRunner(
        { gitleaks: { status: 1, stdout: "leaks found" } },
        true,
    );
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("gitleaks"));
});

test("gitleaks scans repo scope, not just workflow files", async () => {
    const { runner, calls } = fakeRunner({}, true);
    await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });
    const gitleaksCall = calls.find((c) => c[0] === "gitleaks")!;
    assert.deepEqual(gitleaksCall.slice(1, 3), ["dir", "--config"]);
    assert.equal(gitleaksCall[4], ".");
});

test("parseIgnoredPaths keeps ignored dirs and files, drops other entries", () => {
    const status = [
        " M modified.txt",
        "?? untracked.txt",
        "!! .env",
        "!! bin/",
        "!! src/App/obj/",
        "!! .dotnet/",
    ].join("\n");
    assert.deepEqual(parseIgnoredPaths({ status }), [
        ".env",
        "bin/",
        "src/App/obj/",
        ".dotnet/",
    ]);
});

test("escapeRegexPath escapes regex metacharacters", () => {
    assert.equal(escapeRegexPath("src/App.Core/bin/"), "src/App\\.Core/bin/");
    assert.equal(escapeRegexPath(".env"), "\\.env");
    assert.equal(escapeRegexPath("a+b"), "a\\+b");
});

test("buildGitleaksConfig anchors files end-to-end and dirs as prefixes", () => {
    const config = buildGitleaksConfig({
        ignoredPaths: [".env", "bin/", "obj/"],
    });
    assert.ok(config.includes("[extend]"));
    assert.ok(config.includes("useDefault = true"));
    // files: anchored end-to-end in a TOML literal string (single quotes)
    assert.ok(config.includes("'^\\.env$'"));
    // dirs: anchored as a prefix
    assert.ok(config.includes("'^bin/'"));
    assert.ok(config.includes("'^obj/'"));
});

test("buildGitleaksConfig with no ignored paths emits default rules only", () => {
    const config = buildGitleaksConfig({ ignoredPaths: [] });
    assert.ok(config.includes("useDefault = true"));
    // An empty `paths = []` is rejected by gitleaks; no allowlist section.
    assert.ok(!config.includes("[allowlist]"));
});
