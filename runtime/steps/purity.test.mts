// Tests for steps/purity.mts: selection, invocation and result classification.
// Run: node --test runtime/steps/purity.test.mts
//
// The rule semantics themselves are exercised by the baked-rule fixture
// (runtime/purity-fixture.test.mts); these tests pin the step's edge contract:
// skip before invocation, one batch, policy in env, and no silent pass.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import type { CommandResult } from "../../lib/proc.mts";
import { runPurityStep } from "./purity.mts";
import {
    cleanupTempDirs,
    makeTempDir,
    recordingRunner,
} from "../test-helpers.mts";

afterEach(cleanupTempDirs);

async function makeRepo(config: unknown): Promise<string> {
    const dir = await makeTempDir("quality-purity-");
    await writeFile(`${dir}/.defined.json`, `${JSON.stringify(config)}\n`);
    return dir;
}

function eslintResult({
    root,
    status = 0,
    files = [] as string[],
    messages = {} as Record<string, unknown[]>,
    stderr = "",
}: {
    root: string;
    status?: number;
    files?: string[];
    messages?: Record<string, unknown[]>;
    stderr?: string;
}): CommandResult {
    return {
        status,
        stdout: JSON.stringify(
            files.map((file) => ({
                filePath: `${root}/${file}`,
                messages: messages[file] ?? [],
            })),
        ),
        stderr,
        signal: null,
        timedOut: false,
        cancelled: false,
        truncated: false,
    };
}

test("purity skips in fix mode without loading the policy or invoking ESLint", async () => {
    // Arrange
    const dir = await makeRepo({
        purity: { pureModules: ["lib/a.ts"] },
    });
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runPurityStep({
        ctx: { mode: "fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner,
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.match(result.notice ?? "", /read-only/u);
    assert.equal(calls.length, 0);
});

test("purity skips when .defined.json declares no policy", async () => {
    // Arrange
    const dir = await makeRepo({});
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner,
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.match(result.notice ?? "", /not declared/u);
    assert.equal(calls.length, 0);
});

test("purity reports a stale selector as an error before invoking ESLint", async () => {
    // Arrange
    const dir = await makeRepo({
        purity: { pureModules: ["lib/missing.ts"] },
    });
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /matches no supported file/u);
    assert.equal(calls.length, 0);
});

test("purity names a selector pointing outside the content scope", async () => {
    // Arrange
    const dir = await makeRepo({
        purity: { pureModules: ["legacy/**"] },
    });
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["src/a.mts"],
        scratchFiles: ["src/a.mts", "legacy/a.mts"],
        runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(
        result.notice ?? "",
        /outside the content scope declared by scope\.include \(e\.g\. "legacy\/a\.mts"\)/u,
    );
    assert.equal(calls.length, 0);
});

test("purity reports a target outside the gated files before invoking ESLint", async () => {
    // Arrange
    const dir = await makeRepo({
        purity: {
            commands: [{ file: "lib/receipts.mts", name: "saveReceipt" }],
        },
    });
    const { runner, calls } = recordingRunner();

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/other.mts"],
        runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /not in the git scope/u);
    assert.equal(calls.length, 0);
});

test("purity runs one ESLint batch over the baked config with the policy in env", async () => {
    // Arrange
    const dir = await makeRepo({
        purity: {
            pureModules: ["lib/**/*.ts"],
            commands: [{ file: "lib/receipts.mts", name: "saveReceipt" }],
            queries: [{ file: "lib/receipts.mts", name: "readReceipt" }],
        },
    });
    const files = ["lib/a.ts", "lib/receipts.mts", "lib/nested/b.ts"];
    const { runner, calls } = recordingRunner({
        eslint: {
            status: 0,
            stdout: eslintResult({ root: dir, files }).stdout,
        },
    });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: files,
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.cmd, "eslint");
    assert.deepEqual(call.args.slice(0, 6), [
        "--no-config-lookup",
        "--config",
        `${call.args[2]}`,
        "--format",
        "json",
        "--no-inline-config",
    ]);
    assert.match(call.args[2]!, /purity\.config\.mjs$/u);
    assert.deepEqual(call.args.slice(6), [
        "lib/a.ts",
        "lib/nested/b.ts",
        "lib/receipts.mts",
    ]);
    const policy = JSON.parse(call.env?.DEFINED_PURITY_POLICY ?? "{}") as {
        pure: string[];
        cqs: Record<string, unknown>;
    };
    assert.deepEqual(policy.pure, ["lib/a.ts", "lib/nested/b.ts"]);
    assert.deepEqual(Object.keys(policy.cqs), ["lib/receipts.mts"]);
});

test("purity fails with stable diagnostics for each baked-rule finding", async () => {
    // Arrange
    const dir = await makeRepo({
        purity: { pureModules: ["lib/a.ts"] },
    });
    const { runner } = recordingRunner({
        eslint: {
            status: 1,
            stdout: eslintResult({
                root: dir,
                status: 1,
                files: ["lib/a.ts"],
                messages: {
                    "lib/a.ts": [
                        {
                            ruleId: "defined/pure-module",
                            severity: 2,
                            line: 14,
                            column: 1,
                            message:
                                'imports "node:fs/promises". Move the Node built-in use to the caller.',
                        },
                    ],
                },
            }).stdout,
        },
    });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.equal(result.errors?.length, 1);
    assert.deepEqual(result.errors?.[0], {
        kind: "finding",
        file: "lib/a.ts",
        line: 14,
        column: 1,
        rule: "defined/pure-module",
        message:
            'imports "node:fs/promises". Move the Node built-in use to the caller.',
    });
});

test("purity treats a parse error as an execution error, not a pass", async () => {
    // Arrange
    const dir = await makeRepo({ purity: { pureModules: ["lib/a.ts"] } });
    const { runner } = recordingRunner({
        eslint: {
            status: 1,
            stdout: eslintResult({
                root: dir,
                status: 1,
                files: ["lib/a.ts"],
                messages: {
                    "lib/a.ts": [
                        {
                            ruleId: null,
                            severity: 2,
                            fatal: true,
                            line: 1,
                            column: 5,
                            message: "Parsing error: Unexpected token",
                        },
                    ],
                },
            }).stdout,
        },
    });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /parse error/u);
});

test("purity treats an ignored-file warning as an execution error", async () => {
    // Arrange
    const dir = await makeRepo({ purity: { pureModules: ["lib/a.ts"] } });
    const { runner } = recordingRunner({
        eslint: {
            status: 0,
            stdout: eslintResult({
                root: dir,
                files: ["lib/a.ts"],
                messages: {
                    "lib/a.ts": [
                        {
                            ruleId: null,
                            severity: 1,
                            message:
                                "File ignored because of a matching ignore pattern.",
                        },
                    ],
                },
            }).stdout,
        },
    });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /warning/u);
});

test("purity rejects a missing verdict for a selected file", async () => {
    // Arrange
    const dir = await makeRepo({
        purity: { pureModules: ["lib/a.ts", "lib/b.ts"] },
    });
    const { runner } = recordingRunner({
        eslint: {
            status: 0,
            stdout: eslintResult({ root: dir, files: ["lib/a.ts"] }).stdout,
        },
    });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts", "lib/b.ts"],
        runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /no eslint verdict for "lib\/b\.ts"/u);
});

test("purity rejects unreadable JSON", async () => {
    // Arrange
    const dir = await makeRepo({ purity: { pureModules: ["lib/a.ts"] } });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner: recordingRunner({
            eslint: { status: 0, stdout: "not json" },
        }).runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /unreadable eslint JSON/u);
});

test("purity rejects a crashed ESLint status", async () => {
    // Arrange
    const dir = await makeRepo({ purity: { pureModules: ["lib/a.ts"] } });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner: recordingRunner({
            eslint: { status: 2, stderr: "boom" },
        }).runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /eslint failed: boom/u);
});

test("purity rejects exit 1 with no parsed findings", async () => {
    // Arrange
    const dir = await makeRepo({ purity: { pureModules: ["lib/a.ts"] } });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner: recordingRunner({
            eslint: {
                status: 1,
                stdout: eslintResult({
                    root: dir,
                    status: 1,
                    files: ["lib/a.ts"],
                }).stdout,
            },
        }).runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /failed without findings/u);
});

test("purity rejects an unexpected ESLint rule id", async () => {
    // Arrange
    const dir = await makeRepo({ purity: { pureModules: ["lib/a.ts"] } });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner: recordingRunner({
            eslint: {
                status: 1,
                stdout: eslintResult({
                    root: dir,
                    status: 1,
                    files: ["lib/a.ts"],
                    messages: {
                        "lib/a.ts": [
                            {
                                ruleId: "no-undef",
                                severity: 2,
                                line: 1,
                                column: 1,
                                message: "'x' is not defined.",
                            },
                        ],
                    },
                }).stdout,
            },
        }).runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /unexpected eslint message/u);
});

test("purity reports a missing eslint binary as an execution error", async () => {
    // Arrange
    const dir = await makeRepo({ purity: { pureModules: ["lib/a.ts"] } });
    const runner = (async () => {
        throw new Error("spawn eslint ENOENT");
    }) as typeof import("../../lib/proc.mts").run;

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(
        result.notice ?? "",
        /purity: eslint could not run: spawn eslint ENOENT/u,
    );
});

test("purity re-reads the policy every run and never replays a stale verdict", async () => {
    // Arrange
    const dir = await makeRepo({
        purity: { queries: [{ file: "lib/a.ts", name: "read" }] },
    });
    const { runner, calls } = recordingRunner({
        eslint: {
            status: 0,
            stdout: eslintResult({ root: dir, files: ["lib/a.ts"] }).stdout,
        },
    });

    const runBoth = async (): Promise<{
        first: Awaited<ReturnType<typeof runPurityStep>>;
        second: Awaited<ReturnType<typeof runPurityStep>>;
    }> => {
        const first = await runPurityStep({
            ctx: { mode: "no-fix", repoRoot: dir },
            trackedFiles: ["lib/a.ts"],
            runner,
        });
        await writeFile(
            `${dir}/.defined.json`,
            JSON.stringify({
                purity: { commands: [{ file: "lib/a.ts", name: "save" }] },
            }),
        );
        const second = await runPurityStep({
            ctx: { mode: "no-fix", repoRoot: dir },
            trackedFiles: ["lib/a.ts"],
            runner,
        });
        return { first, second };
    };

    // Act
    const { first, second } = await runBoth();

    // Assert
    assert.equal(first.status, "pass");
    assert.equal(second.status, "pass");
    assert.equal(calls.length, 2);
    const firstPolicy = JSON.parse(
        calls[0]!.env?.DEFINED_PURITY_POLICY ?? "{}",
    ) as { cqs: Record<string, unknown> };
    const secondPolicy = JSON.parse(
        calls[1]!.env?.DEFINED_PURITY_POLICY ?? "{}",
    ) as { cqs: Record<string, unknown> };
    assert.deepEqual(firstPolicy.cqs["lib/a.ts"], {
        commands: [],
        queries: ["read"],
    });
    assert.deepEqual(secondPolicy.cqs["lib/a.ts"], {
        commands: ["save"],
        queries: [],
    });
});

test("purity rejects a malformed eslint result with no messages array", async () => {
    // Arrange
    const dir = await makeRepo({ purity: { pureModules: ["lib/a.ts"] } });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: ["lib/a.ts"],
        runner: recordingRunner({
            eslint: {
                status: 0,
                stdout: JSON.stringify([{ filePath: `${dir}/lib/a.ts` }]),
            },
        }).runner,
    });

    // Assert
    assert.equal(result.status, "error");
    assert.match(result.notice ?? "", /malformed eslint result/u);
});

test("purity sorts and dedupes the selected batch deterministically", async () => {
    // Arrange
    const dir = await makeRepo({
        purity: {
            pureModules: ["lib/z.ts", "lib/a.ts"],
            queries: [{ file: "lib/a.ts", name: "readA" }],
        },
    });
    const files = ["lib/z.ts", "lib/a.ts"];
    const { runner, calls } = recordingRunner({
        eslint: {
            status: 0,
            stdout: eslintResult({
                root: dir,
                files: ["lib/a.ts", "lib/z.ts"],
            }).stdout,
        },
    });

    // Act
    const result = await runPurityStep({
        ctx: { mode: "no-fix", repoRoot: dir },
        trackedFiles: files,
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    assert.deepEqual(calls[0]!.args.slice(6), ["lib/a.ts", "lib/z.ts"]);
});
