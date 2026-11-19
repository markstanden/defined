// Tests for lib/config.mts: .defined.json reader and typed configuration.
// Run: node --test runtime/lib/config.test.mts

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { loadConfig } from "./config.mts";
import { cleanupTempDirs, makeTempDir, TEST_SHA } from "../test-helpers.mts";

afterEach(cleanupTempDirs);

async function writeConfig(dir: string, content: string): Promise<void> {
    await writeFile(`${dir}/.defined.json`, content);
}

async function assertLoadRejects({
    dir,
    config,
    re,
}: {
    dir: string;
    config: Record<string, unknown>;
    re: RegExp;
}): Promise<void> {
    await writeConfig(dir, JSON.stringify(config));
    await assert.rejects(() => loadConfig({ repoRoot: dir }), re);
}

const SHA = TEST_SHA;

test("loadConfig returns empty config when file is absent", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.version, "");
    assert.equal(config.coverage, undefined);
});

test("loadConfig parses version-only config", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ version: SHA }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.version, SHA);
    assert.equal(config.coverage, undefined);
});

test("loadConfig parses full config with coverage minimums", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    const cfg = {
        version: SHA,
        coverage: {
            node: {
                command: "npm run test:coverage",
                minimums: { line: 80, branch: 70, function: 90 },
            },
            dotnet: {
                command: "dotnet test --collect:XPlat",
                minimums: { line: 85 },
            },
        },
    };
    await writeConfig(dir, JSON.stringify(cfg));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.version, SHA);
    assert.equal(config.coverage?.node?.command, "npm run test:coverage");
    assert.equal(config.coverage?.node?.minimums?.line, 80);
    assert.equal(config.coverage?.node?.minimums?.branch, 70);
    assert.equal(config.coverage?.node?.minimums?.function, 90);
    assert.equal(
        config.coverage?.dotnet?.command,
        "dotnet test --collect:XPlat",
    );
    assert.equal(config.coverage?.dotnet?.minimums?.line, 85);
    assert.equal(config.coverage?.dotnet?.minimums?.branch, undefined);
});

test("loadConfig parses coverage entry without minimums", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    const cfg = {
        version: SHA,
        coverage: {
            node: { command: "npm run test:coverage" },
        },
    };
    await writeConfig(dir, JSON.stringify(cfg));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.coverage?.node?.command, "npm run test:coverage");
    assert.equal(config.coverage?.node?.minimums, undefined);
});

test("loadConfig rejects invalid JSON", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, "{ not valid json }");

    // Act & Assert
    await assert.rejects(() => loadConfig({ repoRoot: dir }), /invalid JSON/u);
});

test("loadConfig rejects non-object root", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify("just a string"));

    // Act & Assert
    await assert.rejects(
        () => loadConfig({ repoRoot: dir }),
        /must be a JSON object/u,
    );
});

test("loadConfig rejects array root", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify([1, 2, 3]));

    // Act & Assert
    await assert.rejects(
        () => loadConfig({ repoRoot: dir }),
        /must be a JSON object/u,
    );
});

test("loadConfig rejects invalid version values", async () => {
    // Arrange
    const BAD_VERSIONS = [
        { label: "too short", config: { version: "abc123" } },
        {
            label: "non-hex",
            config: { version: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" },
        },
        {
            label: "uppercase",
            config: { version: "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2" },
        },
        { label: "non-string", config: { version: 1234567 } },
        { label: "empty string", config: { version: "" } },
        { label: "null", config: { version: null } },
        { label: "latest", config: { version: "latest" } },
    ] as const;

    for (const { label, config } of BAD_VERSIONS) {
        // Act & Assert
        await assertLoadRejects({
            dir: await makeTempDir("quality-config-"),
            config,
            re: /"version" must be a 7–40 character hex SHA/u,
        });
        assert.ok(true, `rejects ${label}`);
    }
});

test("loadConfig parses the flat node checks form", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    const cfg = {
        node: {
            install: "npm ci",
            checks: [
                { name: "lint", command: "eslint ." },
                {
                    name: "test",
                    command: "vitest run",
                    fix: "vitest run --update",
                },
            ],
        },
    };
    await writeConfig(dir, JSON.stringify(cfg));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.node?.packages.length, 1);
    const pkg = config.node!.packages[0]!;
    assert.equal(pkg.dir, undefined);
    assert.equal(pkg.install, "npm ci");
    assert.deepEqual(pkg.checks, [
        { name: "lint", command: "eslint .", fix: undefined },
        { name: "test", command: "vitest run", fix: "vitest run --update" },
    ]);
});

test("loadConfig parses a multi-package node config and normalises dirs", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    const cfg = {
        node: {
            packages: [
                {
                    dir: "packages/a/",
                    install: false,
                    checks: [{ name: "a", command: "eslint ." }],
                },
                {
                    dir: ".",
                    checks: [{ name: "root", command: "tsc --noEmit" }],
                },
            ],
        },
    };
    await writeConfig(dir, JSON.stringify(cfg));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.node?.packages[0]?.dir, "packages/a");
    assert.equal(config.node?.packages[0]?.install, false);
    assert.equal(config.node?.packages[1]?.dir, "");
});

test("loadConfig treats a node key without checks as absent", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ node: {} }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.node, undefined);
});

test("loadConfig parses a coverage.satisfies relationship", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(
        dir,
        JSON.stringify({
            node: { checks: [{ name: "test", command: "vitest run" }] },
            coverage: {
                node: {
                    command: "vitest run --coverage",
                    satisfies: { package: "", check: "test" },
                },
            },
        }),
    );

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.deepEqual(config.coverage?.node?.satisfies, {
        package: "",
        check: "test",
    });
});

test("loadConfig defaults satisfies.package to the repo root", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(
        dir,
        JSON.stringify({
            coverage: {
                node: { command: "c", satisfies: { check: "test" } },
            },
        }),
    );

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.deepEqual(config.coverage?.node?.satisfies, {
        package: "",
        check: "test",
    });
});

test("loadConfig rejects a malformed satisfies relationship", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    const bad: unknown[] = ["test", { check: "" }, { package: 1 }, {}];
    for (const satisfies of bad) {
        await writeConfig(
            dir,
            JSON.stringify({ coverage: { node: { command: "c", satisfies } } }),
        );

        // Act & Assert
        await assert.rejects(() => loadConfig({ repoRoot: dir }), /satisfies/u);
    }
});

test("loadConfig treats a node key without checks as absent", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ node: {} }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.node, undefined);
});

test("loadConfig rejects malformed node configs", async () => {
    // Arrange
    const cases: Array<{ config: unknown; re: RegExp }> = [
        { config: { node: "lint" }, re: /"node" must be an object/u },
        {
            config: { node: { packages: [] } },
            re: /"node\.packages" must be a non-empty array/u,
        },
        {
            config: { node: { packages: [], checks: [] } },
            re: /cannot set both "packages" and "checks"/u,
        },
        {
            config: { node: { checks: [] } },
            re: /"node\.checks" must be a non-empty array/u,
        },
        {
            config: { node: { checks: [{ name: "", command: "x" }] } },
            re: /"node\.checks\[0\]\.name" must be a non-empty string/u,
        },
        {
            config: { node: { checks: [{ name: "x", command: " " }] } },
            re: /"node\.checks\[0\]\.command" must be a non-empty string/u,
        },
        {
            config: { node: { checks: [{ name: "x", command: "y", fix: 1 }] } },
            re: /"node\.checks\[0\]\.fix" must be a non-empty string/u,
        },
        {
            config: {
                node: { install: 7, checks: [{ name: "x", command: "y" }] },
            },
            re: /"node\.install" must be a non-empty string or false/u,
        },
        {
            config: {
                node: { typo: true, checks: [{ name: "x", command: "y" }] },
            },
            re: /unknown node key "typo"/u,
        },
    ];
    for (const { config, re } of cases) {
        // Act & Assert
        await assertLoadRejects({
            dir: await makeTempDir("quality-config-"),
            config: config as Record<string, unknown>,
            re,
        });
    }
});

test("loadConfig accepts a config with no version and keeps coverage", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    const cfg = {
        coverage: {
            node: { command: "npm run test:coverage" },
        },
    };
    await writeConfig(dir, JSON.stringify(cfg));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.version, "");
    assert.equal(config.coverage?.node?.command, "npm run test:coverage");
});

test("loadConfig rejects coverage with unknown ecosystem", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    const cfg = {
        version: SHA,
        coverage: { rust: { command: "cargo tarpaulin" } },
    };
    await writeConfig(dir, JSON.stringify(cfg));

    // Act & Assert
    await assert.rejects(
        () => loadConfig({ repoRoot: dir }),
        /unknown coverage ecosystem "rust"/u,
    );
});

test("loadConfig rejects coverage command that is not non-empty", async () => {
    for (const command of [undefined, "  "]) {
        // Arrange
        const coverage = command === undefined ? {} : { command };

        // Act & Assert
        await assertLoadRejects({
            dir: await makeTempDir("quality-config-"),
            config: { version: SHA, coverage: { node: coverage } },
            re: /"coverage.node.command" must be a non-empty string/u,
        });
    }
});

test("loadConfig rejects minimum outside 0–100", async () => {
    for (const line of [101, -5]) {
        // Act & Assert
        await assertLoadRejects({
            dir: await makeTempDir("quality-config-"),
            config: {
                version: SHA,
                coverage: { node: { command: "npm t", minimums: { line } } },
            },
            re: /must be a number 0–100/u,
        });
    }
});

test("loadConfig rejects unknown minimum metric", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    const cfg = {
        version: SHA,
        coverage: { node: { command: "npm t", minimums: { statements: 80 } } },
    };
    await writeConfig(dir, JSON.stringify(cfg));

    // Act & Assert
    await assert.rejects(
        () => loadConfig({ repoRoot: dir }),
        /unknown minimum metric "statements"/u,
    );
});

test("loadConfig parses naming rules with an optional fix", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    const cfg = {
        naming: { command: "check-names.sh", fix: "fix-names.sh" },
    };
    await writeConfig(dir, JSON.stringify(cfg));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.naming?.command, "check-names.sh");
    assert.equal(config.naming?.fix, "fix-names.sh");
});

test("loadConfig treats a naming key without rules as absent", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ naming: {} }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.naming, undefined);
});

test("loadConfig rejects malformed naming configs", async () => {
    // Arrange
    const cases: Array<{ config: unknown; re: RegExp }> = [
        { config: { naming: "check" }, re: /"naming" must be an object/u },
        {
            config: { naming: { command: " " } },
            re: /"naming\.command" must be a non-empty string/u,
        },
        {
            config: { naming: { command: "check", fix: 7 } },
            re: /"naming\.fix" must be a non-empty string/u,
        },
        {
            config: { naming: { fix: "fix-names.sh" } },
            re: /"naming\.fix" requires "naming\.command"/u,
        },
        {
            config: { naming: { command: "check", typo: true } },
            re: /unknown naming key "typo"/u,
        },
    ];
    for (const { config, re } of cases) {
        // Act & Assert
        await assertLoadRejects({
            dir: await makeTempDir("quality-config-"),
            config: config as Record<string, unknown>,
            re,
        });
    }
});

test("loadConfig parses tofu.dirs and normalises each entry", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(
        dir,
        JSON.stringify({
            tofu: { dirs: ["./infrastructure", "modules/net/"] },
        }),
    );

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.deepEqual(config.tofu?.dirs, ["infrastructure", "modules/net"]);
});

test("loadConfig treats a tofu key without dirs as absent", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ tofu: {} }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.tofu, undefined);
});

test("loadConfig rejects malformed tofu configs", async () => {
    // Arrange
    const cases: Array<{ config: unknown; re: RegExp }> = [
        { config: { tofu: "infra" }, re: /"tofu" must be an object/u },
        {
            config: { tofu: { dirs: [] } },
            re: /"tofu\.dirs" must be a non-empty array/u,
        },
        {
            config: { tofu: { dirs: [" "] } },
            re: /"tofu\.dirs\[0\]" must be a non-empty string/u,
        },
        {
            config: { tofu: { dirs: ["../outside"] } },
            re: /"tofu\.dirs\[0\]" must be a repo-relative directory/u,
        },
        {
            config: { tofu: { dirs: ["/abs"] } },
            re: /"tofu\.dirs\[0\]" must be a repo-relative directory/u,
        },
        {
            config: { tofu: { dirs: ["infra"], typo: true } },
            re: /unknown tofu key "typo"/u,
        },
    ];
    for (const { config, re } of cases) {
        // Act & Assert
        await assertLoadRejects({
            dir: await makeTempDir("quality-config-"),
            config: config as Record<string, unknown>,
            re,
        });
    }
});

test("loadConfig accepts minimum at the boundary of 0 and 100", async () => {
    for (const line of [0, 100]) {
        // Arrange
        const dir = await makeTempDir("quality-config-");
        await writeConfig(
            dir,
            JSON.stringify({
                version: SHA,
                coverage: { node: { command: "npm t", minimums: { line } } },
            }),
        );

        // Act
        const config = await loadConfig({ repoRoot: dir });

        // Assert
        assert.equal(config.coverage?.node?.minimums?.line, line);
    }
});

test("loadConfig parses the eslint disable flag", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ eslint: { disable: true } }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.eslint?.disable, true);
});

test("loadConfig treats an empty eslint key as absent", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ eslint: {} }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.eslint, undefined);
});

test("loadConfig rejects an unknown eslint key or non-boolean disable", async () => {
    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { eslint: { rules: {} } },
        re: /unknown eslint key "rules"/,
    });

    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { eslint: { disable: "yes" } },
        re: /"eslint\.disable" must be a boolean/,
    });
});

test("loadConfig parses the eslint complexityMax override", async () => {
    for (const complexityMax of [10, 1, false] as const) {
        // Arrange
        const dir = await makeTempDir("quality-config-");
        await writeConfig(dir, JSON.stringify({ eslint: { complexityMax } }));

        // Act
        const config = await loadConfig({ repoRoot: dir });

        // Assert
        assert.equal(config.eslint?.complexityMax, complexityMax);
    }
});

test("loadConfig rejects a malformed eslint complexityMax", async () => {
    for (const complexityMax of [0, -3, 2.5, "12", true]) {
        // Act & Assert
        await assertLoadRejects({
            dir: await makeTempDir("quality-config-"),
            config: { eslint: { complexityMax } },
            re: /"eslint\.complexityMax" must be a positive integer or false/u,
        });
    }
});

test("loadConfig parses the eslint recommended override", async () => {
    for (const recommended of [true, false] as const) {
        // Arrange
        const dir = await makeTempDir("quality-config-");
        await writeConfig(dir, JSON.stringify({ eslint: { recommended } }));

        // Act
        const config = await loadConfig({ repoRoot: dir });

        // Assert
        assert.equal(config.eslint?.recommended, recommended);
    }
});

test("loadConfig rejects a non-boolean eslint recommended", async () => {
    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { eslint: { recommended: "off" } },
        re: /"eslint\.recommended" must be a boolean/u,
    });
});

test("loadConfig parses the workflow disable flag", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ workflow: { disable: true } }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.workflow?.disable, true);
});

test("loadConfig treats an empty workflow key as absent", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ workflow: {} }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.workflow, undefined);
});

test("loadConfig rejects an unknown workflow key or non-boolean disable", async () => {
    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { workflow: { host: "ado" } },
        re: /unknown workflow key "host"/,
    });

    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { workflow: { disable: "yes" } },
        re: /"workflow\.disable" must be a boolean/,
    });
});

test("loadConfig parses the dotnet disable flag", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ dotnet: { disable: true } }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.dotnet?.disable, true);
});

test("loadConfig treats an empty dotnet key as absent", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ dotnet: {} }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.dotnet, undefined);
});

test("loadConfig rejects an unknown dotnet key or non-boolean disable", async () => {
    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { dotnet: { framework: "net10.0" } },
        re: /unknown dotnet key "framework"/,
    });

    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { dotnet: { disable: "yes" } },
        re: /"dotnet\.disable" must be a boolean/,
    });
});

test("loadConfig rejects dotnet.disable combined with coverage.dotnet", async () => {
    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: {
            coverage: { dotnet: { command: "dotnet test" } },
            dotnet: { disable: true },
        },
        re: /"dotnet\.disable" cannot be combined with "coverage\.dotnet"/u,
    });
});

const PURITY_JS_TS =
    "a repo-relative JS/TS file (.js, .mjs, .cjs, .jsx, .ts, .mts, .cts, .tsx)";

test("loadConfig parses a purity policy with every list", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    const purity = {
        pureModules: ["lib/system-status.mts", "lib/derive/**/*.ts"],
        commands: [{ file: "lib/receipts.mts", name: "saveReceipt" }],
        queries: [{ file: "lib/receipts.mts", name: "readReceipt" }],
    };
    await writeConfig(dir, JSON.stringify({ purity }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.deepEqual(config.purity, purity);
});

test("loadConfig parses each purity list on its own", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(
        dir,
        JSON.stringify({
            purity: { queries: [{ file: "q.ts", name: "read" }] },
        }),
    );

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.deepEqual(config.purity, {
        queries: [{ file: "q.ts", name: "read" }],
    });
    assert.equal(config.purity?.pureModules, undefined);
    assert.equal(config.purity?.commands, undefined);
});

test("loadConfig treats an empty purity object as opted out", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(dir, JSON.stringify({ purity: {} }));

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.equal(config.purity, undefined);
});

test("loadConfig normalises a leading ./ on purity selectors and target files", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(
        dir,
        JSON.stringify({
            purity: {
                pureModules: ["./lib/a.ts"],
                commands: [{ file: "./lib/b.ts", name: "save" }],
            },
        }),
    );

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.deepEqual(config.purity?.pureModules, ["lib/a.ts"]);
    assert.deepEqual(config.purity?.commands, [
        { file: "lib/b.ts", name: "save" },
    ]);
});

test("loadConfig dedupes repeated purity targets and selectors", async () => {
    // Arrange
    const dir = await makeTempDir("quality-config-");
    await writeConfig(
        dir,
        JSON.stringify({
            purity: {
                pureModules: ["lib/a.ts", "lib/a.ts"],
                commands: [
                    { file: "lib/b.ts", name: "save" },
                    { file: "lib/b.ts", name: "save" },
                ],
            },
        }),
    );

    // Act
    const config = await loadConfig({ repoRoot: dir });

    // Assert
    assert.deepEqual(config.purity?.pureModules, ["lib/a.ts"]);
    assert.deepEqual(config.purity?.commands, [
        { file: "lib/b.ts", name: "save" },
    ]);
});

test("loadConfig rejects unknown purity keys and non-object purity", async () => {
    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { purity: [] },
        re: /"purity" must be an object/u,
    });

    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { purity: { modules: ["lib/a.ts"] } },
        re: /unknown purity key "modules"/u,
    });
});

test("loadConfig rejects empty or non-array purity lists", async () => {
    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { purity: { pureModules: [] } },
        re: /"purity\.pureModules" must be a non-empty array/u,
    });

    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: { purity: { commands: "lib/b.ts" } },
        re: /"purity\.commands" must be a non-empty array/u,
    });
});

test("loadConfig rejects absolute, escaping and unsupported purity selectors", async () => {
    // Arrange
    for (const [selector] of [
        ["/lib/a.ts", "absolute"],
        ["../a.ts", "parent escape"],
        ["lib/../../a.ts", "nested escape"],
        ["lib\\a.ts", "backslash"],
        ["lib/", "trailing slash"],
        ["lib//a.ts", "empty segment"],
    ] as const) {
        // Act & Assert
        await assertLoadRejects({
            dir: await makeTempDir("quality-config-"),
            config: { purity: { pureModules: [selector] } },
            re: /"purity\.pureModules\[0\]" must be a repo-relative path or glob/u,
        });
    }
    for (const selector of ["", "   "]) {
        // Act & Assert
        await assertLoadRejects({
            dir: await makeTempDir("quality-config-"),
            config: { purity: { pureModules: [selector] } },
            re: /"purity\.pureModules\[0\]" must be a non-empty string/u,
        });
    }
});

test("loadConfig rejects malformed purity targets", async () => {
    // Arrange
    const cases: Array<[unknown, RegExp]> = [
        ["lib/b.ts", /"purity\.commands\[0\]" must be an object/u],
        [
            { file: "lib/b.ts", name: "save", role: "command" },
            /unknown purity\.commands\[0\] key "role"/u,
        ],
        [
            { file: "", name: "save" },
            /"purity\.commands\[0\]\.file" must be a non-empty string/u,
        ],
        [
            { file: "/lib/b.ts", name: "save" },
            new RegExp(
                `"purity\\.commands\\[0\\]\\.file" must be ${PURITY_JS_TS.replace(/[.()]/gu, "\\$&")}`,
                "u",
            ),
        ],
        [
            { file: "lib/../b.ts", name: "save" },
            new RegExp(
                `"purity\\.commands\\[0\\]\\.file" must be ${PURITY_JS_TS.replace(/[.()]/gu, "\\$&")}`,
                "u",
            ),
        ],
        [
            { file: "lib/b.py", name: "save" },
            new RegExp(
                `"purity\\.commands\\[0\\]\\.file" must be ${PURITY_JS_TS.replace(/[.()]/gu, "\\$&")}`,
                "u",
            ),
        ],
        [
            { file: "lib/b.ts", name: "not a name" },
            /"purity\.commands\[0\]\.name" must be a JS identifier/u,
        ],
        [
            { file: "lib/b.ts", name: 42 },
            /"purity\.commands\[0\]\.name" must be a JS identifier/u,
        ],
    ];
    for (const [entry, re] of cases) {
        // Act & Assert
        await assertLoadRejects({
            dir: await makeTempDir("quality-config-"),
            config: { purity: { commands: [entry] } },
            re,
        });
    }
});

test("loadConfig rejects one symbol declared as both a command and a query", async () => {
    // Act & Assert
    await assertLoadRejects({
        dir: await makeTempDir("quality-config-"),
        config: {
            purity: {
                commands: [{ file: "lib/receipts.mts", name: "saveReceipt" }],
                queries: [{ file: "lib/receipts.mts", name: "saveReceipt" }],
            },
        },
        re: /"saveReceipt" in "lib\/receipts\.mts" is declared as both a command and a query/u,
    });
});
