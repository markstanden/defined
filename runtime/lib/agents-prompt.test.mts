// Tests for the managed agent block (issue #73): the injected guidance must
// keep the promises the gate actually makes, and must survive a round trip
// through the installer without clobbering project content.
// Run: node --test lib/agents-prompt.test.mts

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
    BLOCK_END,
    BLOCK_START,
    readMarkedBlock,
    writeMarkedBlock,
} from "./agents-block.mts";

const TEMPLATE = join(import.meta.dirname, "..", "config", "agents-block.md");

async function block(): Promise<string> {
    return readMarkedBlock({ templatePath: TEMPLATE });
}

test("the block is well formed and non-trivial", async () => {
    const text = await block();
    assert.ok(text.startsWith(BLOCK_START), "block starts with the marker");
    assert.ok(text.endsWith(BLOCK_END), "block ends with the marker");
    // A guidance block that loses its substance should fail loudly.
    assert.ok(text.split("\n").length > 12, "block carries real guidance");
});

test("the block states run timing: after edits, before commit or handoff", async () => {
    const text = await block();
    assert.match(text, /After a coherent set of edits/u);
    assert.match(text, /before committing or\s+handing work back/u);
});

test("the block tells the agent to inspect repairs and rerun only after a fix", async () => {
    const text = await block();
    assert.match(text, /git diff/u);
    assert.match(text, /do not repeat an unchanged\s+failing command/u);
});

test("the block tells the agent to report a blocked check, not retry it", async () => {
    const text = await block();
    assert.match(text, /could not run at all/u);
    assert.match(text, /report the failing step/u);
});

test("the block forbids weakening checks to get green", async () => {
    const text = await block();
    assert.match(text, /Do not weaken or disable a check/u);
});

test("the block distinguishes seeded (project-owned) from managed artifacts", async () => {
    const text = await block();
    assert.match(text, /seeds house defaults/u);
    assert.match(text, /this project then owns/u);
    assert.match(text, /manages plumbing/u);
    assert.match(text, /never fork them locally/u);
});

test("the block states concise output by default and --full for context", async () => {
    const text = await block();
    assert.match(text, /one compact JSON line/u);
    assert.match(text, /`--full`/u);
    assert.match(text, /results/u);
});

test("the block points at the offline explain surface for lookups", async () => {
    const text = await block();
    assert.match(text, /defined explain/u);
    assert.match(text, /offline/u);
});

test("the block points at the knowledge-docs convention", async () => {
    const text = await block();
    assert.match(text, /Knowledge is documented/u);
    assert.match(text, /standards\/documentation\.md/u);
});

test("the block preserves project content above and below on re-install", async () => {
    const template = await block();
    const root = await mkdtemp(join(tmpdir(), "quality-agents-prompt-"));
    try {
        const target = join(root, "AGENTS.md");
        const above = "# Project\n\nOur house rules.\n\n";
        const below = "\n\n## License\n\nMIT.\n";
        await writeFile(target, `${above}${template}${below}`);
        // A fresh template (simulating a gate update) must replace only the block.
        const updated = template.replace(
            "Tighten the floor",
            "Tighten the floor (updated)",
        );
        await writeMarkedBlock({ filePath: target, block: updated });
        const result = await readFile(target, "utf8");
        assert.ok(result.startsWith(above), "content above is verbatim");
        assert.ok(result.endsWith(below), "content below is verbatim");
        assert.match(result, /floor \(updated\)/u);
        assert.equal(result.includes("Our house rules."), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
