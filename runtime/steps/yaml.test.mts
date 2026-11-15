// Tests for steps/yaml.mts: yamllint over tracked YAML files.
// Runner injected, so no host binaries are needed here.
// Run: node --test runtime/steps/yaml.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    filterYamlFiles,
    parseYamllint,
    runYamlStep,
    YAML_EXTENSIONS,
} from "./yaml.mts";
import { baseCtx, fakeRunner } from "../test-helpers.mts";

test("filterYamlFiles keeps only .yml and .yaml files", () => {
    // Act & Assert
    assert.deepEqual(
        filterYamlFiles({
            files: ["a.yml", "b.yaml", "c.sh", "d.ymlx", "e.YAML"],
        }),
        ["a.yml", "b.yaml"],
    );
});

test("yaml extensions are lowercase only", () => {
    // Act & Assert
    assert.deepEqual(YAML_EXTENSIONS, [".yml", ".yaml"]);
});

test("runYamlStep skips cleanly when no YAML is tracked", async () => {
    // Arrange
    const { runner } = fakeRunner({});

    // Act
    const result = await runYamlStep({
        ctx: baseCtx,
        trackedFiles: ["a.sh"],
        runner,
    });

    // Assert
    assert.equal(result.status, "skip");
});

test("runYamlStep fails naming violation count when yamllint reports", async () => {
    // Arrange
    const { runner } = fakeRunner({
        yamllint: {
            status: 1,
            stdout: "ci.yml:3:81: error line too long (line-length)\n",
        },
    });

    // Act
    const result = await runYamlStep({
        ctx: baseCtx,
        trackedFiles: ["ci.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("yamllint"));
    assert.deepEqual(result.errors, [
        {
            kind: "finding",
            file: "ci.yml",
            line: 3,
            column: 81,
            rule: "line-length",
            message: "line too long",
        },
    ]);
});

test("parseYamllint handles bracket levels and ignores non-finding lines", () => {
    // Act
    const errors = parseYamllint({
        stdout: "a.yml:1:2: [warning] too many spaces (spaces)\nnot a finding\n",
    });

    // Assert
    assert.deepEqual(errors, [
        {
            kind: "finding",
            file: "a.yml",
            line: 1,
            column: 2,
            rule: "spaces",
            message: "too many spaces",
        },
    ]);
});

test("config travels with the gate and -s makes warnings fail", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({});

    // Act
    await runYamlStep({
        ctx: baseCtx,
        trackedFiles: ["ci.yml", "compose.yaml"],
        runner,
    });

    // Assert
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

test("repair skips yamllint entirely (check-only, #65)", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({});

    // Act
    const result = await runYamlStep({
        ctx: { ...baseCtx, mode: "fix" },
        trackedFiles: ["ci.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.match(result.notice ?? "", /deferred to verification/u);
    assert.equal(calls.length, 0);
});
