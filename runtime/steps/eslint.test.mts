// Tests for steps/eslint.mts: house/repo flat-config linting.
// Runner injected, so no host binaries are needed here.
// Run: node --test steps/eslint.test.mts

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { filterEslintFiles, runEslintStep } from "./eslint.mts";
import { ESLINT_EXAMPLE_NAME } from "../lib/eslint-config.mts";
import { cleanupScratch } from "../lib/scratch.mts";
import {
    baseCtx,
    cleanupTempDirs,
    makeTempDir,
    recordingRunner,
} from "../test-helpers.mts";

afterEach(cleanupTempDirs);

async function writeTree(
    root: string,
    files: Record<string, string>,
): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, rel)), { recursive: true });
        await writeFile(join(root, rel), content);
    }
}

function bakedConfigPath(): string {
    return join(import.meta.dirname, "..", "config", "eslint.config.mjs");
}

test("filterEslintFiles keeps lintable extensions and drops the rest", () => {
    assert.deepEqual(
        filterEslintFiles({
            files: [
                "src/a.ts",
                "b.mts",
                "c.jsx",
                "d.json",
                "e.sh",
                "f.md",
                "g.css",
            ],
        }),
        ["src/a.ts", "b.mts", "c.jsx"],
    );
});

test("runEslintStep skips when nothing is lintable", async () => {
    const { runner, calls } = recordingRunner();
    const result = await runEslintStep({
        ctx: baseCtx,
        trackedFiles: ["a.json", "b.md"],
        runner,
    });
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("runEslintStep skips when .defined.json disables it", async () => {
    const root = await makeTempDir("quality-eslint-off-");
    await writeTree(root, {
        ".defined.json": '{ "eslint": { "disable": true } }\n',
        "a.ts": "export const a = 1;\n",
    });
    const { runner, calls } = recordingRunner();
    const result = await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root },
        trackedFiles: [".defined.json", "a.ts"],
        runner,
    });
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("house config runs the baked config from the scratch root", async () => {
    const root = await makeTempDir("quality-eslint-house-");
    await writeTree(root, { "src/a.ts": "export const a = 1;\n" });
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        const result = await runEslintStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["src/a.ts"],
            runner,
        });
        assert.equal(result.status, "pass");
        assert.equal(calls.length, 1);
        const call = calls[0]!;
        assert.equal(call.cmd, "eslint");
        assert.equal(call.args[0], "--config");
        assert.match(call.args[1]!, /runtime\/config\/eslint\.config\.mjs$/u);
        assert.equal(call.args[2], "--format");
        assert.equal(call.args[3], "json");
        assert.equal(call.args[4], "--no-warn-ignored");
        assert.deepEqual(call.args.slice(5), ["src/a.ts"]);
        // No-fix lints the scratch copy, never the read-only checkout.
        assert.equal(call.cwd, scratch.dir);
        assert.notEqual(call.cwd, root);
        // No override declared: the house config keeps its own default.
        assert.equal(call.env?.DEFINED_ESLINT_COMPLEXITY_MAX, undefined);
    } finally {
        cleanupScratch(scratch);
    }
});

test("a complexityMax override reaches the house config as an env var", async () => {
    const root = await makeTempDir("quality-eslint-cx-");
    await writeTree(root, {
        ".defined.json": '{ "eslint": { "complexityMax": 12 } }\n',
        "src/a.ts": "export const a = 1;\n",
    });
    const { runner, calls } = recordingRunner();
    const result = await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root },
        trackedFiles: [".defined.json", "src/a.ts"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.equal(calls[0]!.env?.DEFINED_ESLINT_COMPLEXITY_MAX, "12");
});

test("complexityMax false drops the rule via the off sentinel", async () => {
    const root = await makeTempDir("quality-eslint-cx-off-");
    await writeTree(root, {
        ".defined.json": '{ "eslint": { "complexityMax": false } }\n',
        "src/a.ts": "export const a = 1;\n",
    });
    const { runner, calls } = recordingRunner();
    const result = await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root },
        trackedFiles: [".defined.json", "src/a.ts"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.equal(calls[0]!.env?.DEFINED_ESLINT_COMPLEXITY_MAX, "off");
});

test("a repo config never receives the complexity override", async () => {
    const root = await makeTempDir("quality-eslint-cx-repo-");
    await writeTree(root, {
        "eslint.config.mjs": "export default [];\n",
        ".defined.json": '{ "eslint": { "complexityMax": 7 } }\n',
        "src/a.ts": "export const a = 1;\n",
    });
    const { runner, calls } = recordingRunner();
    const result = await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root },
        trackedFiles: ["eslint.config.mjs", ".defined.json", "src/a.ts"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.equal(
        calls[0]!.env?.DEFINED_ESLINT_COMPLEXITY_MAX,
        undefined,
        "a repo-owned config governs itself",
    );
});

test("house config fix mode --fixes then re-checks in the repo, writing nothing", async () => {
    const root = await makeTempDir("quality-eslint-fix-");
    await writeTree(root, { "src/a.ts": "export const a = 1;\n" });
    const { runner, calls } = recordingRunner();
    const result = await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["src/a.ts"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map((c) => (c.cmd !== "eslint" ? c.cmd : c.args[0])),
        ["--fix", "--config"],
    );
    assert.equal(calls[0]!.cwd, root);
    assert.equal(existsSync(join(root, ESLINT_EXAMPLE_NAME)), false);
});

test("a repo config runs through the repo's eslint and writes the house example", async () => {
    const root = await makeTempDir("quality-eslint-repo-");
    await writeTree(root, {
        "eslint.config.mjs": "export default [];\n",
        "src/a.ts": "export const a = 1;\n",
        ".git/info/exclude": "",
    });
    const notes: string[] = [];
    const { runner, calls } = recordingRunner();
    const result = await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["eslint.config.mjs", "src/a.ts"],
        runner,
        notifyFn: (line) => notes.push(line),
    });
    assert.equal(result.status, "pass");
    // Both passes go through the repo's own ESLint (sh -c), never --config.
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.cmd, "sh");
    const command = calls[0]!.args[1]!;
    assert.match(command, /'eslint'/u);
    assert.doesNotMatch(command, /--config/u);
    assert.match(command, /'eslint\.config\.mjs'/u);
    // The sidecar is the baked house config, byte-for-byte.
    const example = await readFile(join(root, ESLINT_EXAMPLE_NAME), "utf8");
    assert.equal(example, await readFile(bakedConfigPath(), "utf8"));
    // ...and it is excluded from the gate's git scope.
    const exclude = await readFile(join(root, ".git/info/exclude"), "utf8");
    assert.match(exclude, /eslint\.config\.defined\.mjs/u);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /eslint\.config\.defined\.mjs/u);
});

test("repo config in no-fix writes no sidecar and does not notify", async () => {
    const root = await makeTempDir("quality-eslint-repo-check-");
    await writeTree(root, {
        "eslint.config.mjs": "export default [];\n",
        "src/a.ts": "export const a = 1;\n",
    });
    const scratch = { dir: null };
    const { runner, calls } = recordingRunner();
    try {
        const result = await runEslintStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["eslint.config.mjs", "src/a.ts"],
            runner,
            notifyFn: () => {
                throw new Error("no-fix must not notify");
            },
        });
        assert.equal(result.status, "pass");
        assert.equal(calls.length, 1);
        assert.equal(
            existsSync(join(scratch.dir!, ESLINT_EXAMPLE_NAME)),
            false,
        );
        assert.equal(existsSync(join(root, ESLINT_EXAMPLE_NAME)), false);
    } finally {
        cleanupScratch(scratch);
    }
});

test("a fix that leaves findings fails on the re-check and names the rule", async () => {
    const root = await makeTempDir("quality-eslint-findings-");
    await writeTree(root, { "src/a.ts": "export const a = 1;\n" });
    const report = JSON.stringify([
        {
            filePath: join(root, "src/a.ts"),
            messages: [
                {
                    ruleId: "regexp/no-super-linear-move",
                    severity: 2,
                    line: 3,
                },
            ],
        },
    ]);
    let call = 0;
    const runner = (() => {
        call += 1;
        return call === 1
            ? { status: 0, stdout: "", stderr: "" }
            : { status: 1, stdout: report, stderr: "" };
    }) as typeof import("../../lib/proc.mts").run;
    const result = await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["src/a.ts"],
        runner,
    });
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /1 finding\(s\) \(house config\)/u);
    assert.deepEqual(result.errors, [
        {
            kind: "finding",
            file: "src/a.ts",
            line: 3,
            column: 0,
            rule: "regexp/no-super-linear-move",
            message: "",
        },
    ]);
});

test("exit 2 is a config/parse error, distinct from a finding", async () => {
    const root = await makeTempDir("quality-eslint-config-err-");
    await writeTree(root, { "src/a.ts": "export const a = 1;\n" });
    const scratch = { dir: null };
    const { runner } = recordingRunner({
        eslint: { status: 2, stderr: "boom" },
    });
    try {
        const result = await runEslintStep({
            ctx: { ...baseCtx, repoRoot: root, scratch },
            trackedFiles: ["src/a.ts"],
            runner,
        });
        assert.equal(result.status, "error");
        assert.match(
            result.notice ?? "",
            /config\/parse error \(house config\)/u,
        );
        assert.doesNotMatch(result.notice ?? "", /finding\(s\)/u);
        assert.deepEqual(result.errors, [
            {
                kind: "execution",
                message: "eslint: config/parse error (house config): boom",
            },
        ]);
    } finally {
        cleanupScratch(scratch);
    }
});

test("a stale example is removed when the repo has no config", async () => {
    const root = await makeTempDir("quality-eslint-stale-");
    await writeTree(root, {
        "src/a.ts": "export const a = 1;\n",
        ".git/info/exclude": `other\n${ESLINT_EXAMPLE_NAME}\n`,
    });
    await writeFile(join(root, ESLINT_EXAMPLE_NAME), "// stale example\n");
    const { runner } = recordingRunner();
    const result = await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["src/a.ts"],
        runner,
    });
    assert.equal(result.status, "pass");
    assert.equal(existsSync(join(root, ESLINT_EXAMPLE_NAME)), false);
    const exclude = await readFile(join(root, ".git/info/exclude"), "utf8");
    assert.doesNotMatch(exclude, /eslint\.config\.defined\.mjs/u);
    assert.match(exclude, /other/u);
});

function failingRunner(
    stdout: string,
): typeof import("../../lib/proc.mts").run {
    return (() => ({
        status: 1,
        stdout,
        stderr: "",
    })) as typeof import("../../lib/proc.mts").run;
}

test("a finding without a rule id or line still counts", async () => {
    const root = await makeTempDir("quality-eslint-nofields-");
    await writeTree(root, { "src/a.ts": "export const a = 1;\n" });
    const report = JSON.stringify([
        { filePath: join(root, "src/a.ts"), messages: [{ severity: 2 }] },
    ]);
    const result = await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["src/a.ts"],
        runner: failingRunner(report),
    });
    assert.equal(result.status, "fail");
    assert.equal(result.errors?.[0]?.rule, "parse error");
});

test("every finding is reported without truncation", async () => {
    const root = await makeTempDir("quality-eslint-many-");
    await writeTree(root, { "src/a.ts": "export const a = 1;\n" });
    const messages = Array.from({ length: 7 }, (_, i) => ({
        ruleId: "regexp/x",
        severity: 2,
        line: i + 1,
    }));
    const report = JSON.stringify([
        { filePath: join(root, "src/a.ts"), messages },
    ]);
    const result = await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["src/a.ts"],
        runner: failingRunner(report),
    });
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /7 finding\(s\)/u);
    assert.equal(result.errors?.length, 7);
});

test("unparseable, empty, malformed and warning-only reports fall back", async () => {
    const root = await makeTempDir("quality-eslint-fallbacks-");
    await writeTree(root, { "src/a.ts": "export const a = 1;\n" });
    const cases = [
        { stdout: "not json", re: /lint failed \(house config\): not json/u },
        { stdout: "", re: /lint failed \(house config\): no output/u },
        { stdout: "{}", re: /lint failed/u },
        {
            stdout: JSON.stringify([{ filePath: "x", messages: "no" }]),
            re: /lint failed/u,
        },
        {
            stdout: JSON.stringify([{ filePath: 1, messages: [] }]),
            re: /lint failed/u,
        },
        { stdout: JSON.stringify([null]), re: /lint failed/u },
        {
            stdout: JSON.stringify([
                {
                    filePath: "x",
                    messages: [{ severity: 1, ruleId: "w", line: 1 }],
                },
            ]),
            re: /lint failed/u,
        },
    ];
    for (const { stdout, re } of cases) {
        const result = await runEslintStep({
            ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
            trackedFiles: ["src/a.ts"],
            runner: failingRunner(stdout),
        });
        assert.equal(result.status, "fail");
        assert.match(result.notice ?? "", re);
    }
});

test("the example is written without exclusion when there is no git dir", async () => {
    const root = await makeTempDir("quality-eslint-nogit-");
    await writeTree(root, {
        "eslint.config.mjs": "export default [];\n",
        "src/a.ts": "export const a = 1;\n",
    });
    const notes: string[] = [];
    const { runner } = recordingRunner();
    await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["eslint.config.mjs", "src/a.ts"],
        runner,
        notifyFn: (line) => notes.push(line),
    });
    assert.equal(existsSync(join(root, ESLINT_EXAMPLE_NAME)), true);
    assert.doesNotMatch(notes[0]!, /git\/info\/exclude/u);
});

test("an existing exclude file without a trailing newline stays well formed", async () => {
    const root = await makeTempDir("quality-eslint-sep-");
    await writeTree(root, {
        "eslint.config.mjs": "export default [];\n",
        "src/a.ts": "export const a = 1;\n",
        ".git/info/exclude": "foo",
    });
    const { runner } = recordingRunner();
    await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["eslint.config.mjs", "src/a.ts"],
        runner,
        notifyFn: () => {},
    });
    const exclude = await readFile(join(root, ".git/info/exclude"), "utf8");
    assert.equal(exclude, `foo\n${ESLINT_EXAMPLE_NAME}\n`);
});

test("the example write and exclusion are idempotent across runs", async () => {
    const root = await makeTempDir("quality-eslint-idem-");
    await writeTree(root, {
        "eslint.config.mjs": "export default [];\n",
        "src/a.ts": "export const a = 1;\n",
        ".git/info/exclude": "",
    });
    const notes: string[] = [];
    const ctx = { mode: "fix" as const, repoRoot: root };
    const trackedFiles = ["eslint.config.mjs", "src/a.ts"];
    for (let run = 0; run < 2; run += 1) {
        await runEslintStep({
            ctx,
            trackedFiles,
            runner: recordingRunner().runner,
            notifyFn: (line) => notes.push(line),
        });
    }
    assert.equal(notes.length, 2);
    assert.match(notes[0]!, /added it to \.git\/info\/exclude/u);
    assert.doesNotMatch(notes[1]!, /git\/info\/exclude/u);
});

test("prune leaves an exclude file without the entry untouched", async () => {
    const root = await makeTempDir("quality-eslint-prune-");
    await writeTree(root, {
        "src/a.ts": "export const a = 1;\n",
        ".git/info/exclude": "other\n",
    });
    const { runner } = recordingRunner();
    await runEslintStep({
        ctx: { ...baseCtx, repoRoot: root, mode: "fix" },
        trackedFiles: ["src/a.ts"],
        runner,
    });
    assert.equal(
        await readFile(join(root, ".git/info/exclude"), "utf8"),
        "other\n",
    );
});
