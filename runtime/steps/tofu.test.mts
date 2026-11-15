// Tests for steps/tofu.mts: per-directory fmt, tflint, init, validate.
// Runner injected; no host binaries needed.
// Run: node --test runtime/steps/tofu.test.mts

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { filterTofuFiles, runTofuStep, tfDirectories } from "./tofu.mts";
import { cleanupTempDirs, fakeRunner, makeTempDir } from "../test-helpers.mts";

afterEach(cleanupTempDirs);

const REPO = "/repo";

test("filterTofuFiles finds .tf files", () => {
    // Act & Assert
    assert.deepEqual(
        filterTofuFiles({
            files: ["main.tf", "variables.tf", "a.sh", "b.yml"],
        }),
        ["main.tf", "variables.tf"],
    );
});

test("tfDirectories reduces to the top-most module dirs", () => {
    // Act & Assert
    // Root only.
    assert.deepEqual(tfDirectories({ files: ["main.tf", "b.tf"] }), ["."]);
    // A single nested module, no root .tf.
    assert.deepEqual(
        tfDirectories({
            files: ["infrastructure/main.tf", "infrastructure/variables.tf"],
        }),
        ["infrastructure"],
    );
    // Root and a nested module are separate modules; a deeper module under the
    // nested one is dropped (its parent already covers it).
    assert.deepEqual(
        tfDirectories({
            files: [
                "main.tf",
                "infrastructure/main.tf",
                "infrastructure/modules/vnet/main.tf",
            ],
        }),
        [".", "infrastructure"],
    );
    // Sibling modules are both kept, sorted.
    assert.deepEqual(tfDirectories({ files: ["b/main.tf", "a/main.tf"] }), [
        "a",
        "b",
    ]);
    // Nothing to do.
    assert.deepEqual(tfDirectories({ files: ["a.sh"] }), []);
});

test("runTofuStep skips when no .tf files tracked", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runTofuStep({
        ctx: { mode: "no-fix", repoRoot: REPO },
        trackedFiles: ["a.sh", "b.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("no-fix checks each module dir in the scratch, never the repo root", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runTofuStep({
        ctx: { mode: "no-fix", repoRoot: REPO, scratch: { dir: "/scratch" } },
        trackedFiles: ["infrastructure/main.tf"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => c.join(" ")),
        [
            "tofu fmt -check infrastructure/main.tf /scratch",
            "tflint --init /scratch/infrastructure",
            "tflint /scratch/infrastructure",
            "tofu init -backend=false /scratch/infrastructure",
            "tofu validate /scratch/infrastructure",
        ],
    );
});

test("a root-only module runs in the working root", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    await runTofuStep({
        ctx: { mode: "no-fix", repoRoot: REPO, scratch: { dir: "/scratch" } },
        trackedFiles: ["main.tf"],
        runner,
    });

    // Assert
    const validate = calls.find((c) => c[0] === "tofu" && c[1] === "validate")!;
    assert.equal(validate.at(-1), "/scratch");
});

test("fix mode writes each tracked file and runs tflint --fix only (repair-only, #65)", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runTofuStep({
        ctx: { mode: "fix", repoRoot: REPO },
        trackedFiles: ["main.tf"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    // Repair mutations only: fmt -write and tflint --fix (the fmt check and
    // tflint/init/validate run once in the no-fix pass).
    assert.deepEqual(
        calls.map((c) => c.join(" ")),
        [
            "tofu fmt -write main.tf /repo",
            "tflint --init /repo",
            "tflint --fix /repo",
        ],
    );
});

test("a validate failure names the failing directory", async () => {
    // Arrange
    const { runner } = fakeRunner(
        { "tofu validate": { status: 1, stdout: "boom" } },
        true,
    );

    // Act
    const result = await runTofuStep({
        ctx: { mode: "no-fix", repoRoot: REPO, scratch: { dir: "/scratch" } },
        trackedFiles: ["infrastructure/main.tf"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("infrastructure"));
});

test("tofu.dirs restricts the module directories", async () => {
    // Arrange
    const dir = await makeTempDir("quality-tofu-");
    await writeFile(
        `${dir}/.defined.json`,
        JSON.stringify({ tofu: { dirs: ["modules/net"] } }),
    );
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runTofuStep({
        ctx: { mode: "no-fix", repoRoot: dir, scratch: { dir } },
        trackedFiles: ["main.tf", "modules/net/main.tf"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    const inits = calls.filter((c) => c[0] === "tofu" && c[1] === "init");
    assert.equal(inits.length, 1);
    assert.equal(inits[0]!.at(-1), `${dir}/modules/net`);
});

type Outcome = { status?: number; stdout?: string; stderr?: string };
type FailureCase = {
    name: string;
    outcomes: Record<string, Outcome>;
    notice: string;
};

const failureCases: FailureCase[] = [
    {
        name: "fmt check failure",
        outcomes: { "tofu fmt": { status: 1, stderr: "fmt error" } },
        notice: "tofu: fmt",
    },
    {
        name: "tflint init failure",
        outcomes: { "tflint --init": { status: 1, stderr: "plugin error" } },
        notice: "tflint --init",
    },
    {
        name: "tflint issues",
        outcomes: {
            "tflint --init": { status: 0 },
            tflint: { status: 2, stdout: "2 issue(s) found" },
        },
        notice: "2 issue(s) found",
    },
    {
        name: "init failure",
        outcomes: { "tofu init": { status: 1, stderr: "init error" } },
        notice: "tofu: init",
    },
    {
        name: "validate failure",
        outcomes: {
            "tofu validate": { status: 1, stdout: "validation error" },
        },
        notice: "tofu: validate",
    },
];

for (const c of failureCases) {
    test(`${c.name} fails the step`, async () => {
        // Arrange
        const { runner } = fakeRunner(c.outcomes, true);

        // Act
        const result = await runTofuStep({
            ctx: {
                mode: "no-fix",
                repoRoot: REPO,
                scratch: { dir: "/scratch" },
            },
            trackedFiles: ["main.tf"],
            runner,
        });

        // Assert
        assert.equal(result.status, "fail");
        assert.ok((result.notice ?? "").includes(c.notice));
    });
}
