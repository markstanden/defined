// Tests for lib/explain.mts: the read-only, offline guidance surface (#74).
// Run: node --test runtime/lib/explain.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { explainTopic, renderExplanation, STEP_IDS } from "./explain.mts";
import type { DefinedConfig } from "./config.mts";

/** Deps that never touch the filesystem: fake docs, fake config, fake probe. */
function fakeDeps({
    config = { version: "" } as DefinedConfig,
    consumerConfig = undefined as string | undefined,
    doc = "# Fake doc\nbody\n",
} = {}) {
    return {
        standardsDirFn: () => "/gate/standards",
        readFileFn: async () => doc,
        loadConfigFn: async () => config,
        existsFn: (path: string) =>
            consumerConfig !== undefined && path.endsWith(`/${consumerConfig}`),
    };
}

test("explainTopic_step_returnsHouseDocAndGuidance", async () => {
    // Act — one explain call; the fake deps are built inline.
    const e = await explainTopic({
        topic: "shell",
        repoRoot: "/repo",
        deps: fakeDeps({ doc: "# Shell standards\n" }),
    });

    // Assert
    assert.deepEqual(e, {
        topic: "shell",
        kind: "step",
        owner: { side: "house", detail: "image toolchain (shellcheck, shfmt)" },
        doc: "standards/shell.md",
        guidance: "# Shell standards\n",
    });
});

test("explainTopic_shellcheckRule_routesToTheShellDoc", async () => {
    // Act
    const e = await explainTopic({
        topic: "SC2086",
        repoRoot: "/repo",
        deps: fakeDeps(),
    });

    // Assert
    assert.equal(e.kind, "rule");
    assert.equal(e.doc, "standards/shell.md");
});

test("explainTopic_yamllintRule_routesToTheYamlDoc", async () => {
    // Act
    const e = await explainTopic({
        topic: "line-length",
        repoRoot: "/repo",
        deps: fakeDeps(),
    });

    // Assert
    assert.equal(e.kind, "rule");
    assert.equal(e.doc, "standards/yaml.md");
    assert.deepEqual(e.owner, {
        side: "house",
        detail: "runtime/config/yamllint.yml",
    });
});

test("explainTopic_complexityRule_reportsTheConsumerTuningAsMixed", async () => {
    // Act
    const e = await explainTopic({
        topic: "complexity",
        repoRoot: "/repo",
        deps: fakeDeps({
            config: { version: "", eslint: { complexityMax: 12 } },
        }),
    });

    // Assert
    assert.equal(e.doc, "standards/node-eslint.md");
    assert.deepEqual(e.owner, {
        side: "mixed",
        detail: ".defined.json eslint.complexityMax",
    });
});

test("explainTopic_jsdocRule_carriesTheHouseDocAndOwner", async () => {
    // Act
    const e = await explainTopic({
        topic: "jsdoc/require-jsdoc",
        repoRoot: "/repo",
        deps: fakeDeps({ config: { version: "" } }),
    });

    // Assert
    assert.equal(e.doc, "standards/node-eslint.md");
    assert.deepEqual(e.owner, {
        side: "house",
        detail: "runtime/config/eslint.config.mjs",
    });
});

test("explainTopic_jsdocRule_reportsTheConsumerTuningAsMixed", async () => {
    // Act
    const e = await explainTopic({
        topic: "jsdoc/require-jsdoc",
        repoRoot: "/repo",
        deps: fakeDeps({
            config: { version: "", eslint: { requireJsdoc: false } },
        }),
    });

    // Assert
    assert.deepEqual(e.owner, {
        side: "mixed",
        detail: ".defined.json eslint.requireJsdoc",
    });
});

test("explainTopic_repoOwnedEslintConfig_reportsConsumerOwnership", async () => {
    // Act
    const e = await explainTopic({
        topic: "eslint",
        repoRoot: "/repo",
        deps: fakeDeps({ consumerConfig: "eslint.config.mjs" }),
    });

    // Assert
    assert.deepEqual(e.owner, {
        side: "consumer",
        detail: "eslint.config.mjs",
    });
});

test("explainTopic_stepWithoutAStandardsDoc_carriesANotice", async () => {
    // Act
    const e = await explainTopic({
        topic: "tofu",
        repoRoot: "/repo",
        deps: fakeDeps(),
    });

    // Assert
    assert.equal(e.doc, null);
    assert.equal(e.guidance, null);
    assert.match(e.notice!, /tflint|tofu/u);
});

test("explainTopic_nodeCoverage_routesToTheCoverageDoc", async () => {
    // Act
    const e = await explainTopic({
        topic: "node-coverage",
        repoRoot: "/repo",
        deps: fakeDeps(),
    });

    // Assert
    assert.equal(e.doc, "standards/coverage.md");
});

test("explainTopic_dotnetCoverage_routesToTheCoverageDoc", async () => {
    // Act
    const e = await explainTopic({
        topic: "dotnet-coverage",
        repoRoot: "/repo",
        deps: fakeDeps(),
    });

    // Assert
    assert.equal(e.doc, "standards/coverage.md");
});

test("explainTopic_nodeCoverage_noticeNamesTheLcovPath", async () => {
    // Act
    const e = await explainTopic({
        topic: "node-coverage",
        repoRoot: "/repo",
        deps: fakeDeps(),
    });

    // Assert
    assert.match(e.notice!, /coverage\/lcov\.info/u);
});

test("explainTopic_dotnetCoverage_noticeNamesTheCoberturaPaths", async () => {
    // Act
    const e = await explainTopic({
        topic: "dotnet-coverage",
        repoRoot: "/repo",
        deps: fakeDeps(),
    });

    // Assert
    assert.match(e.notice!, /coverage\.cobertura\.xml/u);
});

test("explainTopic_bootstrap_routesToTheDependabotDoc", async () => {
    // Act
    const e = await explainTopic({
        topic: "bootstrap",
        repoRoot: "/repo",
        deps: fakeDeps(),
    });

    // Assert
    assert.equal(e.doc, "standards/dependabot.md");
});

test("explainTopic_unknownTopic_throwsAConciseError", async () => {
    // Act & Assert
    await assert.rejects(
        explainTopic({ topic: "SC99999", repoRoot: "/repo", deps: fakeDeps() }),
        /unknown topic 'SC99999'/u,
    );

    // Act & Assert
    await assert.rejects(
        explainTopic({
            topic: "no-such-rule",
            repoRoot: "/repo",
            deps: fakeDeps(),
        }),
        /unknown topic 'no-such-rule'/u,
    );
});

test("explainTopic_everyStepIdResolves", async () => {
    // Arrange — one case per known step id.
    for (const topic of STEP_IDS) {
        // Act
        const e = await explainTopic({
            topic,
            repoRoot: "/repo",
            deps: fakeDeps(),
        });

        // Assert
        assert.equal(e.kind, "step", topic);
    }
});

test("renderExplanation_isOneCompactJsonLine", async () => {
    // Arrange — an explanation to render.
    const e = await explainTopic({
        topic: "shell",
        repoRoot: "/repo",
        deps: fakeDeps(),
    });

    // Act
    const line = renderExplanation(e);

    // Assert
    assert.equal(line.includes("\n"), false, "single line");
    assert.deepEqual(JSON.parse(line), e);
});
