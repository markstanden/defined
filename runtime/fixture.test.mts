// Integration test: the two-verb runtime contract against a real gate run.
//
// Builds a deliberately-broken git repo (lib/fixture.mts), drives the real
// gate against it in-container via runtime/comply.sh, and asserts:
//   1. `--check-only` FAILS non-zero, read-only (every broken ecosystem picked
//      up, bootstrap drift detected, and every file byte-identical after —
//      hash proof that the read-only pass never writes to the checkout).
//   2. `comply` (the default) bootstraps, repairs the auto-fixable ones
//      (node/shell/yaml/tofu go green), stays red for the check-only workflow
//      step, and reports `not compliant after repair`.
//   3. A file behind the host .prettierignore is never touched — even by
//      comply's repair pass.
//   4. After semantic repair of the workflow file, both `--check-only` and
//      `comply` exit 0 with the single stable `compliant` line.
//
// Requires a container engine + the gate image (comply.sh builds it on first
// run). Skips cleanly when no engine is usable so `node --test` stays
// runnable on a bare machine. It also skips under `act`: act runs each step
// in its own runner container, and the fixture nests the gate *inside* that —
// comply.sh mounts a temp repo path, but that path lives in the runner
// container's namespace, which the host engine (reached via the mounted
// socket) cannot see. Gate-in-container cannot work under act; the real
// runner or direct podman is required.
// Run: node --test fixture.test.mts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

import { createBrokenFixture, brokenFixtureFiles } from "./lib/fixture.mts";
import { run } from "../lib/proc.mts";

function hasEngine(): boolean {
    if (process.env.ACT === "true") {
        return false;
    }
    return existsSync("/usr/bin/podman") || existsSync("/usr/bin/docker");
}

function gateShim(): string {
    // runtime/fixture.test.mts → runtime/comply.sh (two levels up via lib/).
    return resolve(import.meta.dirname, "comply.sh");
}

async function makeTemp(): Promise<string> {
    return mkdtemp(join(tmpdir(), "quality-fixture-"));
}

/** Walk every regular file under root and return path → sha256. */
function hashTree(root: string): Map<string, string> {
    const hashes = new Map<string, string>();
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                const digest = createHash("sha256")
                    .update(readFileSync(full))
                    .digest("hex");
                hashes.set(relative(root, full), digest);
            }
        }
    };
    walk(root);
    return hashes;
}

function assertTreeUntouched(root: string, before: Map<string, string>): void {
    const after = hashTree(root);
    assert.deepEqual(
        [...after].sort(),
        [...before].sort(),
        "verify must never write to the checkout",
    );
}

test(
    "check-only fails read-only on broken code; comply repairs safe findings and stays red for check-only ones",
    { skip: !hasEngine() },
    async () => {
        const root = await makeTemp();
        try {
            await createBrokenFixture({ root });

            // ---- check-only: non-zero, every ecosystem picked up, no writes ----
            const before = hashTree(root);
            const checkOnly = run({
                cmd: gateShim(),
                args: ["--check-only"],
                cwd: root,
            });
            assert.equal(
                checkOnly.status,
                1,
                `check-only should fail, got:\n${checkOnly.stdout}`,
            );
            for (const step of ["node", "shell", "yaml", "workflow", "tofu"]) {
                assert.match(
                    checkOnly.stdout,
                    new RegExp(`^fail ${step} `, "m"),
                    `${step} should be picked up by the check-only pass`,
                );
            }
            // Bootstrap drift is a check-only finding too (fixture has no managed files).
            assert.match(checkOnly.stdout, /^fail bootstrap /m);
            assertTreeUntouched(root, before);

            // ---- comply (default): bootstraps, repairs, workflow stays red ----
            const comply = run({
                cmd: gateShim(),
                args: [],
                cwd: root,
            });
            assert.equal(
                comply.status,
                1,
                "comply still fails (workflow is check-only)",
            );
            assert.match(comply.stdout, /^not compliant after repair/m);
            for (const step of ["node", "shell", "yaml", "tofu"]) {
                assert.doesNotMatch(
                    comply.stdout,
                    new RegExp(`^fail ${step} `, "m"),
                    `${step} should be repaired by comply`,
                );
            }
            assert.match(
                comply.stdout,
                /^fail workflow /m,
                "workflow stays red after comply (actionlint is check-only)",
            );

            // Ignored file untouched even by comply's repair pass.
            const ignored = await readFile(
                join(root, "dotfiles/nvim/lazy-lock.json"),
                "utf8",
            );
            assert.equal(
                ignored,
                brokenFixtureFiles()["dotfiles/nvim/lazy-lock.json"],
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

test(
    "check-only and comply are both green after semantic repair",
    { skip: !hasEngine() },
    async () => {
        const root = await makeTemp();
        try {
            await createBrokenFixture({ root });

            // comply (default) bootstraps managed files + repairs safe findings;
            // workflow stays red until a human/agent fixes the check-only finding.
            const comply = run({
                cmd: gateShim(),
                args: [],
                cwd: root,
            });
            assert.equal(comply.status, 1, "workflow is still check-only-red");

            // Semantic repair: give the workflow a job-level permissions block
            // (zizmor: excessive-permissions) and a runs-on. The fix must also
            // be prettier-formatted (4-space indent, per the .editorconfig
            // comply installed), or the node step stays red.
            const workflowPath = join(
                root,
                ".github/workflows/fixture--build.yml",
            );
            const repaired = [
                "name: CI",
                "on: push",
                "jobs:",
                "    build:",
                "        runs-on: ubuntu-latest",
                "        permissions:",
                "            contents: read",
                "        steps:",
                "            - run: echo hi",
                "",
            ].join("\n");
            await writeFile(workflowPath, repaired);

            for (const args of [["--check-only"], []]) {
                const label = args.length === 0 ? "comply" : args[0];
                const result = run({
                    cmd: gateShim(),
                    args,
                    cwd: root,
                });
                assert.equal(
                    result.status,
                    0,
                    `${label} should pass after semantic repair, got:\n${result.stdout}`,
                );
                assert.deepEqual(
                    result.stdout.trim().split("\n"),
                    ["compliant"],
                    `${label} must print exactly one compliant line`,
                );
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
