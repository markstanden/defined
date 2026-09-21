// Tests for setup.mts: bootstrap installs managed files and seeds AGENTS.md.
// Run: node --test setup.test.mts

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BLOCK_START } from "./lib/agents-block.mts";
import { checkSetup, runSetup } from "./setup.mts";

async function makeTempRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "quality-setup-"));
    await mkdir(join(root, ".git"));
    return root;
}

test("runSetup installs managed files and seeds the AGENTS.md managed block", async () => {
    const repo = await makeTempRepo();
    try {
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

test("runSetup leaves a drifted managed file untouched (raises-only)", async () => {
    const repo = await makeTempRepo();
    try {
        await writeFile(join(repo, ".editorconfig"), "indent_size = 2\n");
        await runSetup({ startDir: repo });
        assert.equal(
            await readFile(join(repo, ".editorconfig"), "utf8"),
            "indent_size = 2\n",
            "the gate never overwrites or merges a drifted managed file",
        );
        const check = await checkSetup({ startDir: repo });
        assert.equal(
            check.files.find((c) => c.name === ".editorconfig")?.status,
            "drift",
            "drift surfaces through checkSetup for the report contract",
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
            ["absent", "absent", "absent", "absent"],
        );
        assert.equal(before.agents, "absent");

        await runSetup({ startDir: repo });
        const after = await checkSetup({ startDir: repo });
        assert.deepEqual(
            after.files.map((c) => c.status),
            ["present", "present", "present", "present"],
        );
        assert.equal(after.agents, "present");
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("checkSetup reports drift when a managed file differs", async () => {
    const repo = await makeTempRepo();
    try {
        await writeFile(join(repo, ".editorconfig"), "indent_size = 2\n");
        const check = await checkSetup({ startDir: repo });
        assert.equal(
            check.files.find((c) => c.name === ".editorconfig")?.status,
            "drift",
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});
