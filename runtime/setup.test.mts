// Tests for setup.mts: bootstrap installs managed files and seeds AGENTS.md.
// Run: node --test setup.test.mts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BLOCK_START } from "./lib/agents-block.mts";
import { checkSetup, runSetup } from "./setup.mts";

async function makeTempRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "quality-setup-"));
    // A real init, not a bare .git dir: runSetup consults `git ls-files` for
    // detection-driven seeding, and git needs a valid repository to answer.
    spawnSync("git", ["init", "-q", root]);
    return root;
}

test("runSetup installs managed files and seeds the AGENTS.md managed block", async () => {
    const repo = await makeTempRepo();
    try {
        await writeFile(join(repo, "App.csproj"), "<Project/>");
        await runSetup({ startDir: repo });
        assert.ok(
            (await readFile(join(repo, ".editorconfig"), "utf8")).includes(
                "root = true",
            ),
        );
        assert.ok(
            (
                await readFile(join(repo, "Directory.Build.props"), "utf8")
            ).includes("<Project>"),
        );
        assert.ok(
            (await readFile(join(repo, ".gitattributes"), "utf8")).includes(
                "eol=lf",
            ),
        );
        assert.ok(
            (
                await readFile(
                    join(repo, ".github/workflows/defined--verify.yml"),
                    "utf8",
                )
            ).includes("defined-gate"),
        );
        const agents = await readFile(join(repo, "AGENTS.md"), "utf8");
        assert.ok(agents.includes(BLOCK_START));
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup seeds a pinned .defined.json when the repo has none", async () => {
    const repo = await makeTempRepo();
    try {
        await runSetup({ startDir: repo });
        const raw = await readFile(join(repo, ".defined.json"), "utf8");
        const config = JSON.parse(raw) as { version?: string };
        assert.match(
            config.version ?? "",
            /^[0-9a-f]{12}$/u,
            "version must be the 12-char pinhash of tool-versions.env",
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup never overwrites an existing .defined.json", async () => {
    const repo = await makeTempRepo();
    try {
        const mine = {
            version: "deadbeef",
            coverage: { node: { command: "npm t" } },
        };
        await writeFile(
            join(repo, ".defined.json"),
            `${JSON.stringify(mine)}\n`,
        );
        await runSetup({ startDir: repo });
        const raw = await readFile(join(repo, ".defined.json"), "utf8");
        assert.deepEqual(JSON.parse(raw), mine);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup preserves pre-existing AGENTS.md content outside the block", async () => {
    const repo = await makeTempRepo();
    try {
        const mine = "# My Project\n\nOnly my conventions live here.\n";
        await writeFile(join(repo, "AGENTS.md"), mine);
        await runSetup({ startDir: repo });
        const agents = await readFile(join(repo, "AGENTS.md"), "utf8");
        assert.ok(
            agents.startsWith(mine.trimStart().slice(0, "# My Project".length)),
        );
        assert.ok(agents.includes(mine));
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup is idempotent: re-run leaves AGENTS.md byte-identical", async () => {
    const repo = await makeTempRepo();
    try {
        await runSetup({ startDir: repo });
        const first = await readFile(join(repo, "AGENTS.md"), "utf8");
        await runSetup({ startDir: repo });
        assert.equal(await readFile(join(repo, "AGENTS.md"), "utf8"), first);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup keeps a repo's own seeded default (never overwrites it)", async () => {
    const repo = await makeTempRepo();
    try {
        await writeFile(join(repo, ".editorconfig"), "indent_size = 2\n");
        await runSetup({ startDir: repo });
        assert.equal(
            await readFile(join(repo, ".editorconfig"), "utf8"),
            "indent_size = 2\n",
            "a seeded default never overwrites the repo's own rules",
        );
        const check = await checkSetup({ startDir: repo });
        assert.equal(
            check.files.find((c) => c.name === ".editorconfig"),
            undefined,
            "a seeded default is never gated by checkSetup",
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup brings a drifted managed workflow back to the gate copy", async () => {
    const repo = await makeTempRepo();
    try {
        const target = join(
            repo,
            ".github",
            "workflows",
            "defined--verify.yml",
        );
        await mkdir(join(repo, ".github", "workflows"), { recursive: true });
        await writeFile(target, "name: Stale\n");
        await runSetup({ startDir: repo });
        assert.doesNotMatch(
            await readFile(target, "utf8"),
            /name: Stale/u,
            "a managed workflow is updated so the gate pin propagates",
        );
        const check = await checkSetup({ startDir: repo });
        assert.equal(
            check.files.find(
                (c) => c.name === ".github/workflows/defined--verify.yml",
            )?.status,
            "present",
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("checkSetup reports absent artifacts and present after setup", async () => {
    const repo = await makeTempRepo();
    try {
        const before = await checkSetup({ startDir: repo });
        assert.deepEqual(
            before.files.map((c) => c.status),
            ["absent"],
        );
        assert.equal(before.agents, "absent");

        await runSetup({ startDir: repo });
        const after = await checkSetup({ startDir: repo });
        assert.deepEqual(
            after.files.map((c) => c.status),
            ["present"],
        );
        assert.equal(after.agents, "present");
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("checkSetup reports drift when the managed workflow differs", async () => {
    const repo = await makeTempRepo();
    try {
        const target = join(
            repo,
            ".github",
            "workflows",
            "defined--verify.yml",
        );
        await mkdir(join(repo, ".github", "workflows"), { recursive: true });
        await writeFile(target, "name: Mine\n");
        const check = await checkSetup({ startDir: repo });
        assert.equal(
            check.files.find(
                (c) => c.name === ".github/workflows/defined--verify.yml",
            )?.status,
            "drift",
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup removes the eslint example sidecar when the repo has no config", async () => {
    const repo = await makeTempRepo();
    try {
        await writeFile(join(repo, "eslint.config.defined.mjs"), "// stale\n");
        await runSetup({ startDir: repo });
        await assert.rejects(
            () => readFile(join(repo, "eslint.config.defined.mjs"), "utf8"),
            { code: "ENOENT" },
            "a stale sidecar must not survive bootstrap (#62: deleted/renamed paths)",
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup prunes the eslint sidecar exclusion from .git/info/exclude", async () => {
    const repo = await makeTempRepo();
    try {
        await mkdir(join(repo, ".git", "info"), { recursive: true });
        await writeFile(
            join(repo, ".git", "info", "exclude"),
            "# keep\nother\neslint.config.defined.mjs\n",
        );
        await runSetup({ startDir: repo });
        const exclude = await readFile(
            join(repo, ".git", "info", "exclude"),
            "utf8",
        );
        assert.equal(
            exclude.split("\n").includes("eslint.config.defined.mjs"),
            false,
            "the stale example must not stay excluded",
        );
        assert.ok(exclude.includes("keep"), "unrelated exclusions preserved");
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup skips the managed workflow when workflow.disable is true", async () => {
    const repo = await makeTempRepo();
    try {
        await writeFile(
            join(repo, ".defined.json"),
            `${JSON.stringify({ version: "deadbeef", workflow: { disable: true } })}\n`,
        );
        await runSetup({ startDir: repo });
        await assert.rejects(
            () =>
                readFile(
                    join(repo, ".github/workflows/defined--verify.yml"),
                    "utf8",
                ),
            { code: "ENOENT" },
            "an opted-out repo is never seeded a workflow it cannot run",
        );
        // Seeded defaults still install; only the workflow is dropped.
        assert.ok(
            (await readFile(join(repo, ".editorconfig"), "utf8")).includes(
                "root = true",
            ),
        );
        const check = await checkSetup({ startDir: repo });
        assert.deepEqual(check.files, [], "verify does not gate the workflow");
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup leaves a present workflow when disabled and warns", async () => {
    const repo = await makeTempRepo();
    try {
        const target = join(
            repo,
            ".github",
            "workflows",
            "defined--verify.yml",
        );
        await mkdir(join(repo, ".github", "workflows"), { recursive: true });
        await writeFile(target, "name: Stale\n");
        await writeFile(
            join(repo, ".defined.json"),
            `${JSON.stringify({ version: "deadbeef", workflow: { disable: true } })}\n`,
        );
        const notices: string[] = [];
        await runSetup({
            startDir: repo,
            notifyFn: (line) => notices.push(line),
        });
        assert.equal(
            await readFile(target, "utf8"),
            "name: Stale\n",
            "comply never deletes a possibly-committed file",
        );
        assert.ok(
            notices.some((line) => line.includes("workflow disabled")),
            "the contributor is told the stale workflow is deliberate",
        );
        const check = await checkSetup({ startDir: repo });
        assert.deepEqual(check.files, [], "drift is not gated when opted out");
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup skips Directory.Build.props when no .NET files are tracked", async () => {
    const repo = await makeTempRepo();
    try {
        await runSetup({ startDir: repo });
        await assert.rejects(
            () => readFile(join(repo, "Directory.Build.props"), "utf8"),
            { code: "ENOENT" },
            "MSBuild defaults are not seeded into a repo without .NET projects",
        );
        // Seeded defaults that are not .NET-specific still install.
        assert.ok(
            (await readFile(join(repo, ".editorconfig"), "utf8")).includes(
                "root = true",
            ),
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("runSetup skips Directory.Build.props when dotnet is disabled", async () => {
    const repo = await makeTempRepo();
    try {
        await writeFile(join(repo, "App.csproj"), "<Project/>");
        await writeFile(
            join(repo, ".defined.json"),
            `${JSON.stringify({
                version: "deadbeef",
                dotnet: { disable: true },
            })}\n`,
        );
        await runSetup({ startDir: repo });
        await assert.rejects(
            () => readFile(join(repo, "Directory.Build.props"), "utf8"),
            { code: "ENOENT" },
            "the switch wins even with a .NET project tracked",
        );
        assert.ok(
            (await readFile(join(repo, ".gitattributes"), "utf8")).includes(
                "eol=lf",
            ),
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});
