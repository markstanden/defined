// lib/explain.mts — read-only, offline guidance for `defined explain` (#74).
//
// Resolves a step id (the keys of the run plan) or a rule id (the `rule` field
// a diagnostic carries) to the house doc that governs it, served straight from
// the *pinned* image (standards/ is baked and, in source checkouts, bind-mounted
// over the baked copy). No network, no repo mutation, no excerpting: the whole
// doc verbatim keeps this zero-drift.
//
// It also reports who owns the effective configuration — house or consumer —
// from .defined.json plus a filesystem probe, never inferred from command text.
// Unknown topics throw a concise error; the caller turns that into exit 2, so a
// successful explain is always a parseable JSON object on stdout.
//
// Docs are named relative to standards/ (resolved with standardsDir(), so the
// answer matches whichever revision is running); owner `detail` names a
// repo- or image-relative evidence path.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig, type DefinedConfig } from "./config.mts";
import { standardsDir } from "./config-path.mts";
import { CONSUMER_ESLINT_CONFIGS } from "./eslint-config.mts";

export type OwnerSide = "house" | "consumer" | "mixed" | "n/a";

export interface Owner {
    /** Who governs the topic's effective configuration. */
    side: OwnerSide;
    /** The owning config file or baked path, mutable or not. */
    detail: string;
}

export interface Explanation {
    /** The topic as (normally trimmed) the caller asked it. */
    topic: string;
    /** A run-plan step id or a rule id. */
    kind: "step" | "rule";
    /** House or consumer governance of this topic. */
    owner: Owner;
    /** The governing standards doc path; null when none covers the topic. */
    doc: string | null;
    /** The doc's contents verbatim; null when the doc is absent. */
    guidance: string | null;
    /**
     * One-line at-a-glance pointer: the sole guidance for a topic with no
     * standards doc, shown alongside the doc otherwise.
     */
    notice?: string;
}

/** The run-plan step ids, plus the synthetic `bootstrap` check. */
export const STEP_IDS: readonly string[] = [
    "naming",
    "node-deps",
    "node",
    "eslint",
    "node-checks",
    "node-coverage",
    "dotnet",
    "dotnet-coverage",
    "shell",
    "smoke",
    "yaml",
    "workflow",
    "tofu",
    "bootstrap",
];

interface OwnerContext {
    config: DefinedConfig;
    /** Consumer ESLint config basename at the repo root, if any. */
    consumerEslintConfigName?: string;
}

interface TopicEntry {
    kind: "step" | "rule";
    /** Path relative to standards/, or null when no house doc covers it. */
    docRel: string | null;
    notice?: string;
    owner: (ctx: OwnerContext) => Owner;
}

/** A fixed owner: the house config travels with the image. */
function house(
    detail: string,
    side: OwnerSide = "house",
): (ctx: OwnerContext) => Owner {
    return () => ({ side, detail });
}

/**
 * ESLint ownership: a repo-owned config wins (`consumer`), then an explicit
 * disable, then a house config tuned by `complexityMax`/`requireJsdoc`
 * (`mixed`), else the baked house config.
 */
function eslintOwner(ctx: OwnerContext): Owner {
    if (ctx.consumerEslintConfigName !== undefined) {
        return { side: "consumer", detail: ctx.consumerEslintConfigName };
    }
    if (ctx.config.eslint?.disable === true) {
        return { side: "consumer", detail: ".defined.json eslint.disable" };
    }
    const tuned = [
        ...(ctx.config.eslint?.complexityMax !== undefined
            ? ["eslint.complexityMax"]
            : []),
        ...(ctx.config.eslint?.requireJsdoc !== undefined
            ? ["eslint.requireJsdoc"]
            : []),
    ];
    if (tuned.length > 0) {
        return {
            side: "mixed",
            detail: `.defined.json ${tuned.join(", ")}`,
        };
    }
    return { side: "house", detail: "runtime/config/eslint.config.mjs" };
}

const STEP_ENTRIES: Record<string, TopicEntry> = {
    naming: {
        kind: "step",
        docRel: "naming.md",
        owner: (ctx) =>
            ctx.config.naming?.command !== undefined
                ? { side: "mixed", detail: ".defined.json naming.command" }
                : { side: "house", detail: "standards/naming.md" },
    },
    "node-deps": {
        kind: "step",
        docRel: "testing/node-testing.md",
        owner: house("gate-orchestrated restore"),
    },
    node: {
        kind: "step",
        docRel: "testing/node-testing.md",
        owner: house("runtime/config/prettier.config.mjs"),
    },
    eslint: { kind: "step", docRel: "node-eslint.md", owner: eslintOwner },
    "node-checks": {
        kind: "step",
        docRel: "testing/node-testing.md",
        owner: (ctx) =>
            ctx.config.node !== undefined
                ? { side: "consumer", detail: ".defined.json node" }
                : {
                      side: "n/a",
                      detail: "skips unless .defined.json declares node checks",
                  },
    },
    "node-coverage": {
        kind: "step",
        docRel: "coverage.md",
        notice: "reads coverage/lcov.info; minimums are consumer-configured",
        owner: (ctx) =>
            ctx.config.coverage?.node !== undefined
                ? { side: "consumer", detail: ".defined.json coverage.node" }
                : {
                      side: "n/a",
                      detail: "skips unless .defined.json declares coverage.node",
                  },
    },
    dotnet: {
        kind: "step",
        docRel: "documentation.md",
        notice: "runs dotnet format/build/test when .NET projects are detected",
        owner: (ctx) =>
            ctx.config.dotnet?.disable === true
                ? { side: "consumer", detail: ".defined.json dotnet.disable" }
                : { side: "house", detail: "auto-detected .NET projects" },
    },
    "dotnet-coverage": {
        kind: "step",
        docRel: "coverage.md",
        notice: "reads coverage.cobertura.xml or TestResults/coverage.cobertura.xml; minimums are consumer-configured",
        owner: (ctx) =>
            ctx.config.coverage?.dotnet !== undefined
                ? { side: "consumer", detail: ".defined.json coverage.dotnet" }
                : {
                      side: "n/a",
                      detail: "skips unless .defined.json declares coverage.dotnet",
                  },
    },
    shell: {
        kind: "step",
        docRel: "shell.md",
        owner: house("image toolchain (shellcheck, shfmt)"),
    },
    smoke: {
        kind: "step",
        docRel: null,
        notice: "probes container execution (git --version); no user-facing policy",
        owner: house("n/a", "n/a"),
    },
    yaml: {
        kind: "step",
        docRel: "yaml.md",
        owner: house("runtime/config/yamllint.yml"),
    },
    workflow: {
        kind: "step",
        docRel: "naming.md",
        owner: (ctx) =>
            ctx.config.workflow?.disable === true
                ? { side: "consumer", detail: ".defined.json workflow.disable" }
                : {
                      side: "house",
                      detail: "standards/workflows/defined--verify.yml",
                  },
    },
    tofu: {
        kind: "step",
        docRel: null,
        notice: "runs tflint/init/validate over tracked .tf modules",
        owner: (ctx) =>
            ctx.config.tofu !== undefined
                ? { side: "consumer", detail: ".defined.json tofu" }
                : {
                      side: "n/a",
                      detail: "skips unless tracked .tf modules are present",
                  },
    },
    bootstrap: {
        kind: "step",
        docRel: "dependabot.md",
        notice: "seeds house defaults and manages the workflow + AGENTS block; see the README adoption section",
        owner: house("seeded defaults + managed files (README)"),
    },
};

/** yamllint rule names the gate recognises (house overrides + common defaults). */
const YAMLLINT_RULES = new Set([
    "line-length",
    "document-start",
    "truthy",
    "comments",
    "indentation",
    "key-duplicates",
    "trailing-spaces",
    "empty-lines",
    "new-line-at-end-of-file",
    "braces",
    "brackets",
    "colons",
    "commas",
    "hyphens",
    "new-lines",
    "octal-values",
    "quoted-strings",
]);

const SHELLCHECK_RE = /^SC\d{3,4}$/u;
const REGEXP_RE = /^regexp\/.+$/u;
const JSDOC_RE = /^jsdoc\/.+$/u;

const RULE_ENTRIES: Record<string, TopicEntry> = {
    shellcheck: {
        kind: "rule",
        docRel: "shell.md",
        owner: house("image toolchain (shellcheck)"),
    },
    yamllint: {
        kind: "rule",
        docRel: "yaml.md",
        owner: house("runtime/config/yamllint.yml"),
    },
    complexity: { kind: "rule", docRel: "node-eslint.md", owner: eslintOwner },
    regexp: { kind: "rule", docRel: "node-eslint.md", owner: eslintOwner },
    jsdoc: { kind: "rule", docRel: "node-eslint.md", owner: eslintOwner },
    "naming-convention": {
        kind: "rule",
        docRel: "naming/typescript.md",
        owner: eslintOwner,
    },
};

/** Resolve a raw topic to its entry, or null when nothing recognises it. */
function resolveTopic(
    raw: string,
): { topic: string; entry: TopicEntry } | null {
    const topic = raw.trim();
    if (topic in STEP_ENTRIES) {
        return { topic, entry: STEP_ENTRIES[topic]! };
    }
    if (SHELLCHECK_RE.test(topic)) {
        return { topic, entry: RULE_ENTRIES.shellcheck! };
    }
    if (YAMLLINT_RULES.has(topic)) {
        return { topic, entry: RULE_ENTRIES.yamllint! };
    }
    if (topic === "complexity") {
        return { topic, entry: RULE_ENTRIES.complexity! };
    }
    if (REGEXP_RE.test(topic)) {
        return { topic, entry: RULE_ENTRIES.regexp! };
    }
    if (JSDOC_RE.test(topic)) {
        return { topic, entry: RULE_ENTRIES.jsdoc! };
    }
    if (topic === "@typescript-eslint/naming-convention") {
        return { topic, entry: RULE_ENTRIES["naming-convention"]! };
    }
    return null;
}

/** The concise stderr message an unknown topic produces. */
function unknownTopic(raw: string): Error {
    return new Error(
        `unknown topic '${raw}' — known steps: ${STEP_IDS.join(", ")}; ` +
            "known rules: shellcheck SC<code>, yamllint rules " +
            "(line-length, document-start, truthy, comments, …), eslint " +
            "complexity, regexp/<rule>, jsdoc/<rule>, " +
            "@typescript-eslint/naming-convention",
    );
}

export interface ExplainDeps {
    /** Reads standards docs; injectable so tests need no filesystem. */
    readFileFn?: typeof readFile;
    /** Resolves the standards dir inside the running image or checkout. */
    standardsDirFn?: typeof standardsDir;
    /** Loads the consumer's .defined.json; injectable for tests. */
    loadConfigFn?: typeof loadConfig;
    /** Probes for a consumer-owned eslint config file at the repo root. */
    existsFn?: (path: string) => boolean;
}

async function buildOwnerContext({
    repoRoot,
    loadConfigFn,
    existsFn,
}: {
    repoRoot: string;
    loadConfigFn: typeof loadConfig;
    existsFn: (path: string) => boolean;
}): Promise<OwnerContext> {
    const config = await loadConfigFn({ repoRoot });
    const consumerEslintConfigName = CONSUMER_ESLINT_CONFIGS.find((name) =>
        existsFn(join(repoRoot, name)),
    );
    return { config, consumerEslintConfigName };
}

/**
 * Resolve `topic` against the pinned image and the consumer's config. Throws a
 * concise error for an unknown topic (the caller exits 2); every recognised
 * step or rule yields an Explanation, doc-bearing or notice-bearing.
 */
export async function explainTopic({
    topic,
    repoRoot,
    deps = {},
}: {
    topic: string;
    repoRoot: string;
    deps?: ExplainDeps;
}): Promise<Explanation> {
    const resolved = resolveTopic(topic);
    if (resolved === null) {
        throw unknownTopic(topic);
    }
    const {
        readFileFn = readFile,
        standardsDirFn = standardsDir,
        loadConfigFn = loadConfig,
        existsFn = existsSync,
    } = deps;
    const { entry } = resolved;
    const owner = entry.owner(
        await buildOwnerContext({ repoRoot, loadConfigFn, existsFn }),
    );
    let doc: string | null = null;
    let guidance: string | null = null;
    if (entry.docRel !== null) {
        doc = `standards/${entry.docRel}`;
        guidance = await readFileFn(
            join(standardsDirFn(), entry.docRel),
            "utf8",
        );
    }
    const explanation: Explanation = {
        topic: resolved.topic,
        kind: entry.kind,
        owner,
        doc,
        guidance,
    };
    if (entry.notice !== undefined) {
        explanation.notice = entry.notice;
    }
    return explanation;
}

/** Render an explanation as the single compact JSON line explain prints. */
export function renderExplanation(explanation: Explanation): string {
    return JSON.stringify(explanation);
}
