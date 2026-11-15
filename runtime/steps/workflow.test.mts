// Tests for steps/workflow.mts: actionlint + zizmor + gitleaks.
// Runner injected; no host binaries needed.
// Run: node --test runtime/steps/workflow.test.mts

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
    buildGitleaksConfig,
    escapeRegexPath,
    gitleaksIgnoreArgs,
    parseIgnoredPaths,
    runWorkflowStep,
} from "./workflow.mts";
import {
    filterFixableFiles,
    filterWorkflowFiles,
} from "../lib/workflow-files.mts";
import {
    baseCtx,
    cleanupTempDirs,
    fakeRunner,
    makeTempDir,
} from "../test-helpers.mts";

afterEach(cleanupTempDirs);

/** Repair-mode context: comply's first pass, where autofixes may be applied. */
const fixCtx = { mode: "fix" as const, repoRoot: "/repo" };

test("filterWorkflowFiles keeps only workflow definitions (never dependabot.yml)", () => {
    // Act & Assert
    assert.deepEqual(
        filterWorkflowFiles({
            files: [
                ".github/workflows/ci.yml",
                ".github/dependabot.yml",
                ".github/workflows/cd.yaml",
                "a.sh",
            ],
        }),
        [".github/workflows/ci.yml", ".github/workflows/cd.yaml"],
    );
});

test("filterWorkflowFiles ignores non-workflow yaml in .github/", () => {
    // Act & Assert
    assert.deepEqual(
        filterWorkflowFiles({
            files: [".github/other.yml", ".github/workflows/ci.yml"],
        }),
        [".github/workflows/ci.yml"],
    );
});

test("actionlint never receives dependabot.yml; zizmor audits it", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml", ".github/dependabot.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    const actionlint = calls.find((c) => c[0] === "actionlint")!;
    assert.deepEqual(actionlint.slice(1, -1), [".github/workflows/ci.yml"]);
    const zizmor = calls.find((c) => c[0] === "zizmor")!;
    assert.deepEqual(zizmor.slice(1, -1), [
        "--no-progress",
        ".github/workflows/ci.yml",
        ".github/dependabot.yml",
    ]);
});

test("a dependabot-only repo runs zizmor but never actionlint", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/dependabot.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => c[0]),
        ["zizmor", "git", "gitleaks"],
    );
    assert.ok((result.notice ?? "").includes("zizmor"));
    assert.ok(!(result.notice ?? "").includes("actionlint"));
});

test("runWorkflowStep skips actionlint/zizmor when no workflow files", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: ["a.sh", "b.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    assert.ok((result.notice ?? "").includes("no workflow files"));
    // git status --ignored runs first, then gitleaks still scans the tree
    assert.deepEqual(
        calls.map((c) => c[0]),
        ["git", "gitleaks"],
    );
});

test("actionlint runs on workflow files, then zizmor, then gitleaks", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    const cmds = calls.map((c) => c[0]);
    assert.deepEqual(cmds, ["actionlint", "zizmor", "git", "gitleaks"]);
    // actionlint gets the file as first arg
    assert.deepEqual(calls[0]!.slice(1, 2), [".github/workflows/ci.yml"]);
    // zizmor gets --no-progress and the file, with no severity cap
    assert.deepEqual(calls[1]!.slice(1, -1), [
        "--no-progress",
        ".github/workflows/ci.yml",
    ]);
    // git status --ignored gets --porcelain
    assert.deepEqual(calls[2]!.slice(1, 3), ["status", "--porcelain"]);
    // gitleaks gets "dir --config <temp>" and "." last
    assert.equal(calls[3]![1], "dir");
    assert.equal(calls[3]![2], "--config");
    assert.match(calls[3]![3]!, /defined-gitleaks\.toml$/u);
    assert.equal(calls[3]![4], ".");
});

test("filterFixableFiles drops the gate-managed workflow", () => {
    // Act & Assert
    assert.deepEqual(
        filterFixableFiles({
            files: [
                ".github/workflows/ci.yml",
                ".github/workflows/defined--verify.yml",
                ".github/dependabot.yml",
                "a.sh",
            ],
        }),
        [".github/workflows/ci.yml", ".github/dependabot.yml"],
    );
});

test("fix mode applies zizmor's safe autofixes and nothing else (repair-only, #65)", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runWorkflowStep({
        ctx: fixCtx,
        trackedFiles: [".github/workflows/ci.yml", ".github/dependabot.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    // Repair mutation only: one zizmor --fix. actionlint, zizmor's check and
    // gitleaks run once in the authoritative no-fix pass (#65).
    assert.deepEqual(
        calls.map((c) => c[0]),
        ["zizmor"],
    );
    assert.deepEqual(calls[0]!.slice(1, -1), [
        "--fix",
        "--no-progress",
        ".github/workflows/ci.yml",
        ".github/dependabot.yml",
    ]);
});

test("no-fix mode never asks zizmor to fix", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });

    // Assert
    assert.ok(!calls.some((call) => call.includes("--fix")));
});

test("a failed autofix run does not fail repair; verification decides (#65)", async () => {
    // Arrange
    const { runner } = fakeRunner(
        { "zizmor --fix": { status: 1, stderr: "fixer blew up" } },
        true,
    );

    // Act
    const result = await runWorkflowStep({
        ctx: fixCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
});

test("a finding zizmor leaves fails the verification pass", async () => {
    // Arrange
    const { runner } = fakeRunner(
        {
            "zizmor --no-progress": {
                status: 12,
                stdout: "error[template-injection]: code injection",
            },
        },
        true,
    );

    // Act
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /template-injection/u);
});

test("the fixer never rewrites the gate-managed workflow", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    await runWorkflowStep({
        ctx: fixCtx,
        trackedFiles: [
            ".github/workflows/ci.yml",
            ".github/workflows/defined--verify.yml",
        ],
        runner,
    });

    // Assert
    const fixer = calls.find(
        (call) => call[0] === "zizmor" && call.includes("--fix"),
    )!;
    assert.deepEqual(fixer.slice(1, -1), [
        "--fix",
        "--no-progress",
        ".github/workflows/ci.yml",
    ]);
});

test("a dependabot-only repo still runs the fixer in fix mode", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runWorkflowStep({
        ctx: fixCtx,
        trackedFiles: [".github/dependabot.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    const fixer = calls.find(
        (call) => call[0] === "zizmor" && call.includes("--fix"),
    )!;
    assert.deepEqual(fixer.slice(1, -1), [
        "--fix",
        "--no-progress",
        ".github/dependabot.yml",
    ]);
});

test("actionlint failure fails the step", async () => {
    // Arrange
    const { runner } = fakeRunner(
        { actionlint: { status: 1, stderr: "actionlint error" } },
        true,
    );

    // Act
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("actionlint"));
});

test("zizmor failure fails the step", async () => {
    // Arrange
    const { runner } = fakeRunner(
        { zizmor: { status: 1, stderr: "zizmor error" } },
        true,
    );

    // Act
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("zizmor"));
});

test("zizmor findings survive stderr progress chatter", async () => {
    // Arrange
    const { runner } = fakeRunner(
        {
            zizmor: {
                status: 14,
                stdout: "error[unpinned-uses]: unpinned action reference",
                stderr: " INFO zizmor: 🌈 zizmor v1.29.0\n WARN audit: offline mode",
            },
        },
        true,
    );

    // Act
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /unpinned-uses/u);
});

test("actionlint findings survive stderr chatter", async () => {
    // Arrange
    const { runner } = fakeRunner(
        {
            actionlint: {
                status: 1,
                stdout: 'ci.yml:3:1: unexpected key "foo"',
                stderr: "actionlint 1.7.7",
            },
        },
        true,
    );

    // Act
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /unexpected key/u);
});

test("gitleaks failure fails the step", async () => {
    // Arrange
    const { runner } = fakeRunner(
        { gitleaks: { status: 1, stdout: "leaks found" } },
        true,
    );

    // Act
    const result = await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("gitleaks"));
});

test("gitleaks scans repo scope, not just workflow files", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
    });

    // Assert
    const gitleaksCall = calls.find((c) => c[0] === "gitleaks")!;
    assert.deepEqual(gitleaksCall.slice(1, 3), ["dir", "--config"]);
    assert.equal(gitleaksCall[4], ".");
});

test("runWorkflowStep pins the consumer .gitleaksignore as an explicit ignore path", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    await runWorkflowStep({
        ctx: baseCtx,
        trackedFiles: [".github/workflows/ci.yml"],
        runner,
        existsSyncFn: () => true,
    });

    // Assert
    const gitleaksCall = calls.find((c) => c[0] === "gitleaks")!;
    assert.deepEqual(gitleaksCall.slice(4, 6), [
        "--gitleaks-ignore-path",
        baseCtx.repoRoot,
    ]);
    // The scan target stays last; the ignore path is an added flag.
    assert.equal(gitleaksCall[6], ".");
});

test("gitleaksIgnoreArgs pins the repo root only when the baseline exists", async () => {
    // Arrange
    const bare = await makeTempDir("quality-gitleaks-bare-");

    // Act & Assert
    assert.deepEqual(gitleaksIgnoreArgs({ repoRoot: bare }), []);

    // Arrange
    const withFile = await makeTempDir("quality-gitleaks-ignore-");
    await writeFile(join(withFile, ".gitleaksignore"), "a.md:rule:1\n");

    // Act & Assert
    assert.deepEqual(gitleaksIgnoreArgs({ repoRoot: withFile }), [
        "--gitleaks-ignore-path",
        withFile,
    ]);
});

test("parseIgnoredPaths keeps ignored dirs and files, drops other entries", () => {
    // Arrange
    const status = [
        " M modified.txt",
        "?? untracked.txt",
        "!! .env",
        "!! bin/",
        "!! src/App/obj/",
        "!! .dotnet/",
    ].join("\n");

    // Act & Assert
    assert.deepEqual(parseIgnoredPaths({ status }), [
        ".env",
        "bin/",
        "src/App/obj/",
        ".dotnet/",
    ]);
});

test("escapeRegexPath escapes regex metacharacters", () => {
    // Act & Assert
    assert.equal(escapeRegexPath("src/App.Core/bin/"), "src/App\\.Core/bin/");
    assert.equal(escapeRegexPath(".env"), "\\.env");
    assert.equal(escapeRegexPath("a+b"), "a\\+b");
});

test("buildGitleaksConfig anchors files end-to-end and dirs as prefixes", () => {
    // Act
    const config = buildGitleaksConfig({
        ignoredPaths: [".env", "bin/", "obj/"],
    });

    // Assert
    assert.ok(config.includes("[extend]"));
    assert.ok(config.includes("useDefault = true"));
    // files: anchored end-to-end in a TOML literal string (single quotes)
    assert.ok(config.includes("'^\\.env$'"));
    // dirs: anchored as a prefix
    assert.ok(config.includes("'^bin/'"));
    assert.ok(config.includes("'^obj/'"));
});

test("buildGitleaksConfig with no ignored paths emits default rules only", () => {
    // Act
    const config = buildGitleaksConfig({ ignoredPaths: [] });

    // Assert
    assert.ok(config.includes("useDefault = true"));
    // An empty `paths = []` is rejected by gitleaks; no allowlist section.
    assert.ok(!config.includes("[allowlist]"));
});
