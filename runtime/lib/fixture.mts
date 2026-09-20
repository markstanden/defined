// lib/fixture.mts — build a deliberately-broken git repo for gate integration
// tests.
//
// Each ecosystem gets one deterministic offence. The fixture is generated at
// test time into a temp git repo (never stored in the gate's own tracked
// tree — a committed broken fixture would fail the coding-standards repo's
// own gate). Assertions focus on pick-up + auto-fix, not exact messages:
// check mode fails on each broken ecosystem, --fix repairs the auto-fixable
// ones, and a file behind the host .prettierignore is never touched.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run } from "../../lib/proc.mts";

/** Path → content for every broken file. Deterministic and self-contained. */
export function brokenFixtureFiles(): Record<string, string> {
    return {
        // node: unformatted JSON; prettier --write repairs.
        "package.json": '{ "name" :  "fixture" }\n',

        // shell: shfmt-bad indentation; shfmt -w repairs.
        "script.sh": '#!/usr/bin/env bash\nif true; then\n  echo "hi"\nfi\n',

        // yaml: trailing whitespace; prettier (house config formats YAML) repairs,
        // then yamllint passes.
        "broken.yml": "key:\n  nested: value  \n",

        // workflow: actionlint finding — check-only, the tripwire that must STAY red.
        ".github/workflows/ci.yml":
            "name: CI\non: push\njobs:\n  build:\n    steps:\n      - run: echo hi\n",

        // tofu: fmt drift (misaligned closing brace); tofu fmt repairs. Content is
        // tflint-clean (required_version + required_providers present) so the
        // tflint phase stays green and only the fmt offence gates.
        "main.tf":
            'terraform {\n  required_version = ">= 1.0"\n  required_providers {\n    null = {\n      source  = "hashicorp/null"\n      version = "~> 3.0"\n    }\n  }\n}\n\nresource "null_resource" "probe" {\n   }\n',

        // ignore case: behind the host .prettierignore, must never be touched.
        "dotfiles/nvim/lazy-lock.json": '{ "lock":  true }\n',
        ".prettierignore": "dotfiles/nvim/\n",
    };
}

/**
 * Write the broken fixture into root, git-init it, and commit so every file is
 * tracked. Returns the repo root.
 */
export async function createBrokenFixture({
    root,
}: {
    root: string;
}): Promise<string> {
    for (const [path, content] of Object.entries(brokenFixtureFiles())) {
        await mkdir(join(root, path.split("/").slice(0, -1).join("/")), {
            recursive: true,
        });
        await writeFile(join(root, path), content);
    }
    run({ cmd: "git", args: ["init", "-q"], cwd: root });
    run({
        cmd: "git",
        args: ["config", "user.email", "fixture@test"],
        cwd: root,
    });
    run({ cmd: "git", args: ["config", "user.name", "fixture"], cwd: root });
    // Disable git's background auto-maintenance: `git commit` would otherwise
    // spawn `maintenance run --auto`, which transiently creates and removes
    // .git/objects/maintenance.lock while the tests walk the tree — a race that
    // surfaces as ENOENT in hashTree.
    run({ cmd: "git", args: ["config", "maintenance.auto", "false"], cwd: root });
    run({ cmd: "git", args: ["config", "gc.auto", "0"], cwd: root });
    run({ cmd: "git", args: ["add", "-A"], cwd: root });
    run({ cmd: "git", args: ["commit", "-qm", "broken fixture"], cwd: root });
    return root;
}
