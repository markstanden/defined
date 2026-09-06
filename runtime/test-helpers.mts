// test-helpers.mts — shared scaffolding for the gate's own tests.
//
// Every step test used to carry its own byte-identical fakeRunner, baseCtx and
// temp-dir/cleanup block; SonarQube kept flagging the duplication on the PR
// gate. Single source of truth now: step/config tests import from here.
// Not a lib/ module — it is test-only and must never be imported by gate code.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandResult } from "../lib/proc.mts";
import { cleanupScratch } from "./lib/scratch.mts";

type RunResult = { status: number; stdout?: string; stderr?: string };

type StepArgs = {
    ctx: {
        mode: "fix" | "no-fix";
        repoRoot: string;
        scratch?: { dir: string | null };
    };
    trackedFiles: string[];
    runner: typeof import("../lib/proc.mts").run;
    readFileFn: typeof readFile;
};
type StepFn<T> = (args: StepArgs) => Promise<T>;

/** A valid immutable image pin used across the gate's own tests. */
export const TEST_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

/**
 * Create a temp dir and register it for auto-cleanup. Coverage/config tests
 * that used to each carry their own tempDirs[]/afterEach block now get it
 * free — one source of truth.
 */
export async function makeTempDir(prefix = "quality-test-"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

const tempDirs: string[] = [];

/** Remove every temp dir registered since the last call. */
export async function cleanupTempDirs(): Promise<void> {
    await Promise.all(
        tempDirs
            .splice(0)
            .map((dir) => rm(dir, { recursive: true, force: true })),
    );
}

/**
 * Write a .defined.json into root and (optionally) a coverage report file at a
 * nested path. Filters remove the boilerplate the coverage tests all shared.
 */
export async function setupCoverageRepo({
    root,
    config,
    reportPath,
    reportContent,
}: {
    root: string;
    config: Record<string, unknown>;
    reportPath?: string;
    reportContent?: string;
}): Promise<void> {
    await writeFile(join(root, ".defined.json"), `${JSON.stringify(config)}\n`);
    if (reportPath !== undefined && reportContent !== undefined) {
        await mkdir(join(root, reportPath.split("/").slice(0, -1).join("/")), {
            recursive: true,
        });
        await writeFile(join(root, reportPath), reportContent);
    }
}

/**
 * Run a coverage step against a temp repo with an injected fake runner,
 * returning the step result plus the recorded runner calls. Removes the
 * identical invocation tail every coverage test used to repeat.
 */
export async function runCoverageScenario<T>({
    step,
    repoRoot,
    mode = "no-fix",
    trackedFiles,
    runnerOutcomes = {},
}: {
    step: StepFn<T>;
    repoRoot: string;
    mode?: "fix" | "no-fix";
    trackedFiles: string[];
    runnerOutcomes?: Record<string, RunResult>;
}): Promise<{ result: T; calls: string[][] }> {
    const { runner, calls } = fakeRunner(runnerOutcomes);
    const scratch = { dir: null };
    try {
        const result = await step({
            ctx: { mode, repoRoot, scratch },
            trackedFiles,
            runner,
            readFileFn: readFile,
        });
        return { result, calls };
    } finally {
        cleanupScratch(scratch);
    }
}

/**
 * Scriptable fake runner: maps command name (or "cmd subcommand") to canned
 * results and records every call as [cmd, ...args] (plus trailing cwd when
 * present). `withCwd` selects the cwd-aware variant used by steps whose
 * commands take a working directory.
 */
export function fakeRunner(
    outcomes: Record<string, RunResult>,
    withCwd = false,
): { runner: typeof import("../lib/proc.mts").run; calls: string[][] } {
    const calls: string[][] = [];
    const runner = (({
        cmd,
        args,
        cwd,
    }: {
        cmd: string;
        args: string[];
        cwd?: string;
    }) => {
        if (withCwd) {
            calls.push([cmd, ...args, cwd ?? ""]);
            const key = `${cmd} ${args[0] ?? ""}`.trim();
            const o = outcomes[key] ?? outcomes[cmd] ?? { status: 0 };
            return {
                status: o.status,
                stdout: o.stdout ?? "",
                stderr: o.stderr ?? "",
            } satisfies CommandResult;
        }
        calls.push([cmd, ...args]);
        const o = outcomes[cmd] ?? { status: 0 };
        return {
            status: o.status,
            stdout: o.stdout ?? "",
            stderr: o.stderr ?? "",
        } satisfies CommandResult;
    }) as typeof import("../lib/proc.mts").run;
    return { runner, calls };
}

/** Default step context: check-only, repo at /repo. */
export const baseCtx = {
    mode: "no-fix" as const,
    repoRoot: "/repo",
};
