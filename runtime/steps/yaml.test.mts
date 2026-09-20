// Tests for steps/yaml.mts: yamllint over tracked YAML files.
// Runner injected, so no host binaries are needed here.
// Run: node --test steps/yaml.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { filterYamlFiles, runYamlStep, YAML_EXTENSIONS } from "./yaml.mts";
import { baseCtx, fakeRunner } from "../test-helpers.mts";

test("filterYamlFiles keeps only .yml and .yaml files", () => {
    assert.deepEqual(
        filterYamlFiles({
            files: ["a.yml", "b.yaml", "c.sh", "d.ymlx", "e.YAML"],
        }),
        ["a.yml", "b.yaml"],
    );
});

test("yaml extensions are lowercase only", () => {
    assert.deepEqual(YAML_EXTENSIONS, [".yml", ".yaml"]);
});

test("runYamlStep skips cleanly when no YAML is tracked", async () => {
    const { runner } = fakeRunner({});
    const result = await runYamlStep({
        ctx: baseCtx,
        trackedFiles: ["a.sh"],
        runner,
    });
    assert.equal(result.status, "skip");
});

test("runYamlStep fails naming violation count when yamllint reports", async () => {
    const { runner } = fakeRunner({
        yamllint: {
            status: 1,
            stdout: "ci.yml:3:81: error line too long (line-length)\n",
        },
    });
    const result = await runYamlStep({
        ctx: baseCtx,
        trackedFiles: ["ci.yml"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("yamllint"));
});

test("config travels with the gate and -s makes warnings fail", async () => {
    const { runner, calls } = fakeRunner({});
    await runYamlStep({
        ctx: baseCtx,
        trackedFiles: ["ci.yml", "compose.yaml"],
        runner,
    });
    const call = calls.find((c) => c[0] === "yamllint")!;
    assert.equal(call[1], "-c");
    assert.match(call[2]!, /runtime\/config\/yamllint\.yml$/u);
    assert.deepEqual(call.slice(3), [
        "-s",
        "-f",
        "parsable",
        "ci.yml",
        "compose.yaml",
    ]);
});

test("fix mode does not rewrite: yamllint has no autofix", async () => {
    const { runner, calls } = fakeRunner({});
    const result = await runYamlStep({
        ctx: { ...baseCtx, mode: "fix" },
        trackedFiles: ["ci.yml"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.equal(calls.filter((c) => c[0] === "yamllint").length, 1);
});
