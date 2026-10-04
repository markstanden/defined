// lib/fixture.mts — build a deliberately-broken git repo for gate integration
// tests.
//
// Each ecosystem gets deterministic offences (eslint owns two: the regex
// floor and the documentation floor). The fixture is generated at test time
// into a temp git repo (never stored in the gate's own tracked tree — a
// committed broken fixture would fail the coding-standards repo's own gate).
// Assertions focus on pick-up + auto-fix, not exact messages: check mode
// fails on each broken ecosystem, --fix repairs the auto-fixable ones, and
// a file behind the host .prettierignore is never touched.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run } from "../../lib/proc.mts";

/** Path → content for every broken file. Deterministic and self-contained. */
export function brokenFixtureFiles(): Record<string, string> {
    return {
        // node: unformatted JSON; prettier --write repairs.
        "package.json": '{ "name" :  "fixture" }\n',

        // eslint offence 1: the super-linear-regex spelling from system-config's
        // lib/healthcheck.mts (Sonar typescript:S8786), fixed in its PR #62.
        // Not auto-fixable, so it stays red after comply like the workflow
        // finding; the regression proof that the house rule catches it.
        "lib/healthcheck.mts":
            "export const MARKDOWN_LINK = /\\[[^\\]]*\\]\\(([^)]*)\\)/g;\n",

        // eslint offence 2 (2026-10-03): the public-API documentation floor.
        // Undocumented exported function/class, an empty interface-method
        // docblock, and a @param name that does not match the signature —
        // one file covering the floor's three checks. None of it is
        // auto-fixable (the jsdoc fixers are disabled), so eslint stays red
        // after comply until the semantic repair supplies real prose.
        "lib/contracts.mts":
            "export interface Probe {\n    /** */\n    measure(value: number): number;\n}\n\nexport function measureAll(value: number): number {\n    return value;\n}\n\nexport const describe = function (value: number): string {\n    return String(value);\n};\n\nexport class Meter {\n    read(): number {\n        return 1;\n    }\n\n    /** Scales the value.\n     *\n     * @param multiplier the scaling factor\n     */\n    scale(value: number, factor: number): number {\n        return value * factor;\n    }\n}\n",

        // shell: shfmt-bad indentation; shfmt -w repairs.
        "script.sh": '#!/usr/bin/env bash\nif true; then\n  echo "hi"\nfi\n',

        // yaml: trailing whitespace; prettier (house config formats YAML) repairs,
        // then yamllint passes.
        "broken.yml": "key:\n  nested: value  \n",

        // workflow: actionlint finding — check-only, the tripwire that must STAY
        // red. The filename follows the naming grammar so the always-on naming
        // step stays green; only the workflow finding gates.
        ".github/workflows/fixture--build.yml":
            "name: CI\non: push\njobs:\n  build:\n    steps:\n      - run: echo hi\n",

        // tofu: fmt drift (misaligned closing brace); tofu fmt repairs. The
        // config is provider-free — core-only `terraform_data` and no
        // `required_providers` — so `tofu init -backend=false` fetches nothing
        // over the network (#89). tflint stays green: its
        // `terraform_required_providers` rule only checks providers actually
        // referenced, so an absent block is clean and only the fmt offence
        // gates. Keep the e2e independent of registry egress.
        "main.tf":
            'terraform {\n  required_version = ">= 1.0"\n}\n\nresource "terraform_data" "probe" {\n   }\n',

        // dotnet (2026-10-03): the CS1591 floor. A packageless classlib (no
        // NuGet sources needed) with an undocumented public static holder —
        // the shape avoids CA1822/CA1052 so the seeded floor's only findings
        // are the two CS1591 doc errors. dotnet test exits 0 on a classlib.
        // Bootstrap seeds Directory.Build.props on comply; check-only on a
        // fresh clone has no props yet, so this offence reads as compliant
        // there and red after comply — the seeded-defaults adoption path
        // itself, end to end.
        ".gitignore": "obj/\nbin/\n",
        "src/Contracts/Contracts.csproj":
            '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n',
        "src/Contracts/Probe.cs":
            "namespace Contracts;\n\npublic static class Probe\n{\n    public static int Measure(int value)\n    {\n        return value;\n    }\n}\n",

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
    run({
        cmd: "git",
        args: ["config", "maintenance.auto", "false"],
        cwd: root,
    });
    run({ cmd: "git", args: ["config", "gc.auto", "0"], cwd: root });
    run({ cmd: "git", args: ["add", "-A"], cwd: root });
    run({ cmd: "git", args: ["commit", "-qm", "broken fixture"], cwd: root });
    return root;
}
