// Integration test: the two-verb runtime contract against a real gate run.
//
// Builds a deliberately-broken git repo (lib/fixture.mts), drives the real
// gate against it in-container via runtime/comply.sh, and asserts:
//   1. `--check-only` FAILS non-zero, read-only (every broken ecosystem picked
//      up, bootstrap drift detected, and every file byte-identical after —
//      hash proof that the read-only pass never writes to the checkout).
//   2. `comply` (the default) bootstraps, repairs the auto-fixable ones
//      (node/shell/yaml/tofu go green), stays red for the check-only workflow
//      step, and reports a `not_compliant` JSON result.
//   3. A file behind the host .prettierignore is never touched — even by
//      comply's repair pass.
//   4. After semantic repair of the workflow file, both `--check-only` and
//      `comply` exit 0 with a `compliant` JSON result.
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

interface GateResult {
    status: string;
    results: Record<string, string>;
    errors?: Array<{
        check: string;
        kind: string;
        message: string;
        rule?: string;
    }>;
}

/** Parse the single JSON result line the gate prints to stdout. */
function parseGate(stdout: string): GateResult {
    const line = stdout.trim().split("\n").filter(Boolean).at(-1);
    assert.ok(line, "the gate must print a JSON result line");
    return JSON.parse(line!) as GateResult;
}

/** True when a check is present and not a clean pass or skip. */
function isUnsuccessful(result: GateResult, check: string): boolean {
    return ["fail", "error", "blocked"].includes(result.results[check] ?? "");
}

// Deterministic, engine-free regression guard for #89: the tofu fixture must
// stay provider-free. A provider declaration, a `provider` block or any
// resource other than the core-only `terraform_data` makes `tofu init` fetch a
// registry provider, and flaky egress then fails this e2e for a reason
// unrelated to the change under test.
test("the tofu fixture declares no provider and fetches nothing over the network", () => {
    const mainTf = brokenFixtureFiles()["main.tf"] ?? "";
    assert.match(mainTf, /resource "terraform_data"/u);
    assert.doesNotMatch(
        mainTf,
        /required_providers|\bprovider\s+"|\bresource\s+"(?!terraform_data")/u,
        "the tofu fixture must not declare a provider or a provider-backed resource (#89)",
    );
});

test(
    "check-only fails read-only on broken code; comply repairs safe findings and stays red for check-only ones",
    { skip: !hasEngine() },
    async () => {
        const root = await makeTemp();
        try {
            await createBrokenFixture({ root });

            // ---- check-only: non-zero, every ecosystem picked up, no writes ----
            const before = hashTree(root);
            const checkOnly = await run({
                cmd: gateShim(),
                args: ["--check-only", "--full", "--timings"],
                cwd: root,
            });
            assert.equal(
                checkOnly.status,
                1,
                `check-only should fail, got:\n${checkOnly.stdout}`,
            );
            // --timings is instrumentation only: stdout stays one JSON result
            // line, and the phase/step durations land on stderr.
            assert.match(
                checkOnly.stderr,
                /defined: timing no-fix\/naming \d+ms/u,
                "check-only must report step timings on stderr with --timings",
            );
            assert.match(
                checkOnly.stderr,
                /defined: timing verify total \d+ms/u,
            );
            const checked = parseGate(checkOnly.stdout);
            assert.equal(checked.status, "not_compliant");
            for (const step of [
                "node",
                "eslint",
                "shell",
                "yaml",
                "workflow",
                "tofu",
            ]) {
                assert.ok(
                    isUnsuccessful(checked, step),
                    `${step} should be picked up by the check-only pass, got ${checked.results[step]}`,
                );
            }
            // Bootstrap drift is a check-only finding too (fixture has no managed files).
            assert.equal(checked.results.bootstrap, "fail");
            assert.ok(
                checked.errors?.some((error) => error.check === "bootstrap"),
                "bootstrap drift must appear in errors",
            );
            // The documentation floor must appear in errors: broken docblocks
            // are findings (eslint), never repair output (no autofill).
            assert.ok(
                checked.errors?.some(
                    (error) =>
                        error.check === "eslint" &&
                        error.rule?.startsWith("jsdoc/"),
                ),
                "a jsdoc documentation finding must appear in errors",
            );
            assertTreeUntouched(root, before);

            // ---- comply: bootstraps, repairs, workflow stays red ----
            const comply = await run({
                cmd: gateShim(),
                args: ["--full"],
                cwd: root,
            });
            assert.equal(
                comply.status,
                1,
                "comply still fails (workflow is check-only)",
            );
            const repaired = parseGate(comply.stdout);
            assert.equal(repaired.status, "not_compliant");
            for (const step of ["node", "shell", "yaml", "tofu"]) {
                assert.equal(
                    isUnsuccessful(repaired, step),
                    false,
                    `${step} should be repaired by comply, got ${repaired.results[step]}`,
                );
            }
            assert.equal(
                repaired.results.workflow,
                "fail",
                "workflow stays red after comply (actionlint is check-only)",
            );
            assert.equal(
                repaired.results.eslint,
                "fail",
                "eslint stays red after comply (the regexp rule is not auto-fixable)",
            );
            assert.equal(
                repaired.results.dotnet,
                "fail",
                "dotnet stays red after comply (CS1591 needs written prose, not a fixer)",
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

            // comply bootstraps managed files + repairs safe findings; workflow
            // stays red until a human/agent fixes the check-only finding.
            const comply = await run({
                cmd: gateShim(),
                args: ["--full"],
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

            // Repair the ESLint findings: the post-fix regex from
            // system-config PR #62 (exclude `[` from the class), and the
            // documentation floor's real prose — written by hand, never
            // autofilled, matching the seeded style (4-space indent).
            await writeFile(
                join(root, "lib/healthcheck.mts"),
                "export const MARKDOWN_LINK = /\\[[^\\[\\]]*\\]\\(([^)]*)\\)/g;\n",
            );
            await writeFile(
                join(root, "lib/contracts.mts"),
                [
                    "/** Probes numeric values by echoing them back. */",
                    "export interface Probe {",
                    "    /** Echoes the supplied value back to the caller. */",
                    "    measure(value: number): number;",
                    "}",
                    "",
                    "/**",
                    " * Measures the supplied value by returning it unchanged.",
                    " *",
                    " * @param value the value to measure; any number is accepted",
                    " * @returns the same value that was supplied",
                    " */",
                    "export function measure(value: number): number {",
                    "    return value;",
                    "}",
                    "",
                ].join("\n"),
            );

            // Repair the CS1591 finding: the documented static holder. The
            // shape (static class + static member) keeps the CA analysers
            // quiet so the only red/green delta is the documentation itself.
            await writeFile(
                join(root, "src/Contracts/Probe.cs"),
                [
                    "namespace Contracts;",
                    "",
                    "/// <summary>",
                    "/// Probes numeric values by echoing them back.",
                    "/// </summary>",
                    "public static class Probe",
                    "{",
                    "    /// <summary>",
                    "    /// Echoes the supplied value back to the caller.",
                    "    /// </summary>",
                    '    /// <param name="value">The value to echo; any integer is accepted.</param>',
                    "    /// <returns>The same value that was supplied.</returns>",
                    "    public static int Measure(int value)",
                    "    {",
                    "        return value;",
                    "    }",
                    "}",
                    "",
                ].join("\n"),
            );

            for (const args of [["--check-only", "--full"], ["--full"]]) {
                const label = args.includes("--check-only")
                    ? "--check-only"
                    : "comply";
                const result = await run({
                    cmd: gateShim(),
                    args,
                    cwd: root,
                });
                assert.equal(
                    result.status,
                    0,
                    `${label} should pass after semantic repair, got:\n${result.stdout}`,
                );
                const gate = parseGate(result.stdout);
                assert.equal(
                    gate.status,
                    "compliant",
                    `${label} must report a compliant result`,
                );
                assert.equal(
                    "errors" in gate,
                    false,
                    `${label} compliant result omits the errors key`,
                );
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
