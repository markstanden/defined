// Tests for lib/explain.mts: the read-only, offline guidance surface (#74).
// Run: node --test runtime/lib/explain.test.mts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { explainTopic, renderExplanation, STEP_IDS } from "./explain.mts";
import {
    ALWAYS_ON_RULES,
    LEAD_RULES,
    REVIEW_RULES,
} from "./test-review/rules.mts";
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
    const topics = STEP_IDS;

    // Act
    const explanations = await Promise.all(
        topics.map((topic) =>
            explainTopic({ topic, repoRoot: "/repo", deps: fakeDeps() }),
        ),
    );

    // Assert
    assert.deepEqual(
        explanations.map((explanation) => explanation.kind),
        topics.map(() => "step"),
    );
});

test("explainTopic_propertyTestingGuide_routesToThePropertyDoc", async () => {
    // Act
    const e = await explainTopic({
        topic: "property-testing",
        repoRoot: "/repo",
        deps: fakeDeps({ doc: "# Property testing\n" }),
    });

    // Assert
    assert.deepEqual(e, {
        topic: "property-testing",
        kind: "guide",
        owner: {
            side: "house",
            detail: "standards/testing/property-testing.md",
        },
        doc: "standards/testing/property-testing.md",
        guidance: "# Property testing\n",
        notice: "the C#/FsCheck property shape: law, generator and shrinker, seed ledger, canary and layout",
    });
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

test("explainTopic_purityRules_routeToThePurityDoc", async () => {
    // Arrange
    const topics = [
        "defined/pure-module",
        "defined/cqs-command",
        "defined/cqs-query",
        "defined/cqs-targets",
    ];

    // Act
    const explanations = await Promise.all(
        topics.map((topic) =>
            explainTopic({ topic, repoRoot: "/repo", deps: fakeDeps() }),
        ),
    );

    // Assert
    assert.deepEqual(
        explanations.map((explanation) => [explanation.kind, explanation.doc]),
        topics.map(() => ["rule", "standards/node-purity.md"]),
    );
});

/** Rule ids listed in the test-review standards tables, in document order. */
function documentedTestReviewRules(): string[] {
    const doc = readFileSync(
        new URL("../../standards/testing/test-review.md", import.meta.url),
        "utf8",
    );
    return [...doc.matchAll(/^\| `([a-z][a-z-]+)` /gmu)].map(
        (match) => match[1]!,
    );
}

test("explainTopic_everyDocumentedTestReviewRule_routesToTheTestReviewDoc", async () => {
    // Arrange
    const topics = documentedTestReviewRules();

    // Act
    const explanations = await Promise.all(
        topics.map((topic) =>
            explainTopic({ topic, repoRoot: "/repo", deps: fakeDeps() }),
        ),
    );

    // Assert
    assert.ok(topics.length >= 30, "the doc lists the rule catalogue");
    assert.deepEqual(
        explanations.map((explanation) => [explanation.kind, explanation.doc]),
        topics.map(() => ["rule", "standards/testing/test-review.md"]),
    );
});

test("explainTopic_everyEngineTestReviewRule_routesToTheTestReviewDoc", async () => {
    // Arrange
    const topics = [...ALWAYS_ON_RULES, ...REVIEW_RULES, ...LEAD_RULES];

    // Act
    const explanations = await Promise.all(
        topics.map((topic) =>
            explainTopic({ topic, repoRoot: "/repo", deps: fakeDeps() }),
        ),
    );

    // Assert
    assert.deepEqual(
        explanations.map((explanation) => explanation.doc),
        topics.map(() => "standards/testing/test-review.md"),
    );
});

test("explainTopic_testReviewRule_isHouseOwned", async () => {
    // Act
    const explanation = await explainTopic({
        topic: "compound-assertion",
        repoRoot: "/repo",
        deps: fakeDeps(),
    });

    // Assert
    assert.deepEqual(explanation.owner, {
        side: "house",
        detail: "runtime/lib/test-review/",
    });
});

test("explainTopic_purityOwner_isConsumerWhenDeclaredAndNotApplicableOtherwise", async () => {
    // Arrange
    const declared = fakeDeps({
        config: {
            version: "",
            purity: { pureModules: ["lib/a.ts"] },
        } as DefinedConfig,
    });

    // Act
    const [undeclaredExplanation, declaredExplanation] = await Promise.all([
        explainTopic({ topic: "purity", repoRoot: "/repo", deps: fakeDeps() }),
        explainTopic({ topic: "purity", repoRoot: "/repo", deps: declared }),
    ]);

    // Assert
    assert.equal(undeclaredExplanation.owner.side, "n/a");
    assert.equal(declaredExplanation.owner.side, "consumer");
});
