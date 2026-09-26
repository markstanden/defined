// Tests for steps/tofu.mts: per-directory fmt, tflint, init, validate.
// Runner injected; no host binaries needed.
// Run: node --test steps/tofu.test.mts

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { filterTofuFiles, runTofuStep, tfDirectories } from "./tofu.mts";
import { cleanupTempDirs, fakeRunner, makeTempDir } from "../test-helpers.mts";

afterEach(cleanupTempDirs);

const REPO = "/repo";

test("filterTofuFiles finds .tf files", () => {
    assert.deepEqual(
        filterTofuFiles({
            files: ["main.tf", "variables.tf", "a.sh", "b.yml"],
        }),
        ["main.tf", "variables.tf"],
    );
});

test("tfDirectories reduces to the top-most module dirs", () => {
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
    const { runner, calls } = fakeRunner({}, true);
    const result = await runTofuStep({
        ctx: { mode: "no-fix", repoRoot: REPO },
        trackedFiles: ["a.sh", "b.yml"],
        runner,
    });
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("no-fix checks each module dir in the scratch, never the repo root", async () => {
    const { runner, calls } = fakeRunner({}, true);
    const result = await runTofuStep({
        ctx: { mode: "no-fix", repoRoot: REPO, scratch: { dir: "/scratch" } },
        trackedFiles: ["infrastructure/main.tf"],
        runner,
    });
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
    const { runner, calls } = fakeRunner({}, true);
    await runTofuStep({
        ctx: { mode: "no-fix", repoRoot: REPO, scratch: { dir: "/scratch" } },
        trackedFiles: ["main.tf"],
        runner,
    });
    const validate = calls.find((c) => c[0] === "tofu" && c[1] === "validate")!;
    assert.equal(validate.at(-1), "/scratch");
});

test("fix mode formats each tracked file then re-checks", async () => {
    const { runner, calls } = fakeRunner({}, true);
    const result = await runTofuStep({
        ctx: { mode: "fix", repoRoot: REPO },
        trackedFiles: ["main.tf"],
        runner,
    });
    assert.equal(result.status, "pass");
    const fmtCalls = calls.filter((c) => c[0] === "tofu" && c[1] === "fmt");
    assert.deepEqual(
        fmtCalls.map((c) => c.slice(0, -1)),
        [
            ["tofu", "fmt", "-write", "main.tf"],
            ["tofu", "fmt", "-check", "main.tf"],
        ],
    );
});

test("a validate failure names the failing directory", async () => {
    const { runner } = fakeRunner(
        { "tofu validate": { status: 1, stdout: "boom" } },
        true,
    );
    const result = await runTofuStep({
        ctx: { mode: "fix", repoRoot: REPO },
        trackedFiles: ["infrastructure/main.tf"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("infrastructure"));
});

test("tofu.dirs restricts the module directories", async () => {
    const dir = await makeTempDir("quality-tofu-");
    await writeFile(
        `${dir}/.defined.json`,
        JSON.stringify({ tofu: { dirs: ["modules/net"] } }),
    );
    const { runner, calls } = fakeRunner({}, true);
    const result = await runTofuStep({
        ctx: { mode: "fix", repoRoot: dir },
        trackedFiles: ["main.tf", "modules/net/main.tf"],
        runner,
    });
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
        name: "fmt failure in fix mode",
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
        const { runner } = fakeRunner(c.outcomes, true);
        const result = await runTofuStep({
            ctx: { mode: "fix", repoRoot: REPO },
            trackedFiles: ["main.tf"],
            runner,
        });
        assert.equal(result.status, "fail");
        assert.ok((result.notice ?? "").includes(c.notice));
    });
}
