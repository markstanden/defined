// Tests for steps/dotnet.mts: .NET format, build, test via dotnet CLI.
// Runner injected; no host binaries needed.
// Run: node --test runtime/steps/dotnet.test.mts

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
    filterDotNetFiles,
    discoverWorkspace,
    runDotNetStep,
} from "./dotnet.mts";
import {
    baseCtx,
    cleanupTempDirs,
    fakeRunner,
    makeTempDir,
} from "../test-helpers.mts";
import { cleanupScratch } from "../lib/scratch.mts";

afterEach(cleanupTempDirs);

/** A real temp repo with a root csproj, so no-fix scratch copies succeed. */
async function makeDotnetRepo(): Promise<string> {
    const repoRoot = await makeTempDir("quality-dotnet-");
    await writeFile(
        join(repoRoot, "MyProj.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk"/>',
    );
    return repoRoot;
}

test("filterDotNetFiles finds csproj, sln, slnx files", () => {
    // Act & Assert
    assert.deepEqual(
        filterDotNetFiles({
            files: ["a.csproj", "sln.sln", "b.slnx", "c.sh", "d.yml"],
        }),
        ["a.csproj", "sln.sln", "b.slnx"],
    );
});

test("discoverWorkspace prefers explicit env, then single slnx/sln/csproj, else repo root", () => {
    // Act & Assert
    // explicit env
    assert.equal(
        discoverWorkspace({
            repoRoot: "/repo",
            workspaceEnv: "/repo/explicit.slnx",
            slnxFiles: [],
            slnFiles: [],
            csprojFiles: [],
        }),
        "/repo/explicit.slnx",
    );
    // Act & Assert
    // single slnx
    assert.equal(
        discoverWorkspace({
            repoRoot: "/repo",
            slnxFiles: ["proj.slnx"],
            slnFiles: [],
            csprojFiles: [],
        }),
        "/repo/proj.slnx",
    );
    // Act & Assert
    // single sln
    assert.equal(
        discoverWorkspace({
            repoRoot: "/repo",
            slnxFiles: [],
            slnFiles: ["proj.sln"],
            csprojFiles: [],
        }),
        "/repo/proj.sln",
    );
    // Act & Assert
    // single csproj (nested or root) — the CLI needs a path, not a directory
    assert.equal(
        discoverWorkspace({
            repoRoot: "/repo",
            slnxFiles: [],
            slnFiles: [],
            csprojFiles: ["src/MyApp/MyApp.csproj"],
        }),
        "/repo/src/MyApp/MyApp.csproj",
    );
    // Act & Assert
    // none -> repo root
    assert.equal(
        discoverWorkspace({
            repoRoot: "/repo",
            slnxFiles: [],
            slnFiles: [],
            csprojFiles: [],
        }),
        "/repo",
    );
});

test("discoverWorkspace throws on multiple solutions", () => {
    // Act & Assert
    assert.throws(
        () =>
            discoverWorkspace({
                repoRoot: "/repo",
                slnxFiles: ["a.slnx"],
                slnFiles: ["b.sln"],
                csprojFiles: [],
            }),
        /Multiple solution files/,
    );
});

test("discoverWorkspace throws on multiple projects with no solution", () => {
    // Act & Assert
    assert.throws(
        () =>
            discoverWorkspace({
                repoRoot: "/repo",
                slnxFiles: [],
                slnFiles: [],
                csprojFiles: ["src/A/A.csproj", "tests/B/B.csproj"],
            }),
        /Multiple \.csproj files/,
    );
});

test("runDotNetStep skips cleanly when no .NET files tracked", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runDotNetStep({
        ctx: baseCtx,
        trackedFiles: ["a.sh", "b.yml"],
        runner,
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
});

test("no-fix mode runs restore, format --verify-no-changes, build, test in a scratch workspace", async () => {
    // Arrange
    const repoRoot = await makeDotnetRepo();
    const scratch = { dir: null as string | null };
    try {
        const { runner, calls } = fakeRunner({}, true);

        // Act
        const result = await runDotNetStep({
            ctx: { mode: "no-fix", repoRoot, scratch },
            trackedFiles: ["MyProj.csproj"],
            runner,
        });

        // Assert
        assert.equal(result.status, "pass");
        // Every command runs inside the scratch workspace, never the repo.
        const scratchDir = scratch.dir;
        assert.ok(scratchDir !== null);
        assert.notEqual(scratchDir, repoRoot);
        assert.ok(scratchDir.startsWith(tmpdir()));
        for (const call of calls) {
            assert.equal(call.at(-1), scratchDir);
        }
        const cmds = calls.map((c) => c[0]);
        assert.deepEqual(cmds, ["dotnet", "dotnet", "dotnet", "dotnet"]);
        assert.equal(calls[0]![1], "restore");
        assert.equal(calls[0]![2], join(scratchDir, "MyProj.csproj"));
        assert.equal(calls[1]![1], "format");
        assert.equal(calls[1]![2], "--verify-no-changes");
        assert.equal(calls[2]![1], "build");
        assert.equal(calls[3]![1], "test");
    } finally {
        cleanupScratch(scratch);
    }
});

test("fix mode runs restore and format (write) only, mutating", async () => {
    // Arrange
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runDotNetStep({
        ctx: { ...baseCtx, mode: "fix" },
        trackedFiles: ["src/MyProj.csproj"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    // Repair-only (#65): restore (prerequisite) and format (mutation). No
    // re-verify, build or test — those are verification, done once in the
    // authoritative no-fix pass.
    assert.equal(calls.length, 2);
    assert.equal(calls[0]![1], "restore");
    assert.equal(calls[1]![1], "format");
    assert.equal(calls[1]![2], join(baseCtx.repoRoot, "src/MyProj.csproj"));
});

test("restore failure fails the step before any build", async () => {
    // Arrange
    const repoRoot = await makeDotnetRepo();
    const scratch = { dir: null as string | null };
    try {
        const { runner, calls } = fakeRunner(
            { "dotnet restore": { status: 1, stderr: "restore error" } },
            true,
        );

        // Act
        const result = await runDotNetStep({
            ctx: { mode: "no-fix", repoRoot, scratch },
            trackedFiles: ["MyProj.csproj"],
            runner,
        });

        // Assert
        assert.equal(result.status, "fail");
        assert.ok((result.notice ?? "").includes("dotnet: restore"));
        assert.equal(calls.length, 1);
    } finally {
        cleanupScratch(scratch);
    }
});

test("format failure in fix mode fails the step", async () => {
    // Arrange
    const { runner } = fakeRunner(
        { "dotnet format": { status: 1, stderr: "format error" } },
        true,
    );

    // Act
    const result = await runDotNetStep({
        ctx: { ...baseCtx, mode: "fix" },
        trackedFiles: ["src/MyProj.csproj"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.ok((result.notice ?? "").includes("dotnet: format"));
});

test("build failure fails the step", async () => {
    // Arrange
    const repoRoot = await makeDotnetRepo();
    const scratch = { dir: null as string | null };
    try {
        const { runner } = fakeRunner(
            { "dotnet build": { status: 1, stderr: "build error" } },
            true,
        );

        // Act
        const result = await runDotNetStep({
            ctx: { mode: "no-fix", repoRoot, scratch },
            trackedFiles: ["MyProj.csproj"],
            runner,
        });

        // Assert
        assert.equal(result.status, "fail");
        assert.ok((result.notice ?? "").includes("dotnet: build"));
    } finally {
        cleanupScratch(scratch);
    }
});

test("test failure fails the step", async () => {
    // Arrange
    const repoRoot = await makeDotnetRepo();
    const scratch = { dir: null as string | null };
    try {
        const { runner } = fakeRunner(
            { "dotnet test": { status: 1, stdout: "Failed: 1" } },
            true,
        );

        // Act
        const result = await runDotNetStep({
            ctx: { mode: "no-fix", repoRoot, scratch },
            trackedFiles: ["MyProj.csproj"],
            runner,
        });

        // Assert
        assert.equal(result.status, "fail");
        assert.ok((result.notice ?? "").includes("dotnet: test"));
    } finally {
        cleanupScratch(scratch);
    }
});

test("runDotNetStep skips when dotnet is disabled by .defined.json", async () => {
    // Arrange
    const repoRoot = await makeTempDir("quality-dotnet-off-");
    await writeFile(
        join(repoRoot, ".defined.json"),
        `${JSON.stringify({ dotnet: { disable: true } })}\n`,
    );
    const { runner, calls } = fakeRunner({});

    // Act
    const result = await runDotNetStep({
        ctx: { ...baseCtx, repoRoot },
        trackedFiles: ["MyProj.csproj"],
        runner,
    });

    // Assert
    assert.equal(result.status, "skip");
    assert.equal(
        calls.length,
        0,
        "the switch wins even with .NET files tracked",
    );
});

/** A temp repo holding two projects and no solution: discovery alone throws. */
async function makeTwoProjectRepo(): Promise<string> {
    const repoRoot = await makeTempDir("quality-dotnet-");
    for (const [dir, name] of [
        ["a", "A"],
        ["b", "B"],
    ] as const) {
        await mkdir(join(repoRoot, dir), { recursive: true });
        await writeFile(
            join(repoRoot, dir, `${name}.csproj`),
            '<Project Sdk="Microsoft.NET.Sdk"/>',
        );
    }
    return repoRoot;
}

/** Write a .defined.json into a temp repo. */
async function writeConfig(
    repoRoot: string,
    config: Record<string, unknown>,
): Promise<void> {
    await writeFile(join(repoRoot, ".defined.json"), JSON.stringify(config));
}

test("declared workspaces replace discovery when the repo has several projects", async () => {
    // Arrange
    const repoRoot = await makeTwoProjectRepo();
    await writeConfig(repoRoot, {
        dotnet: { workspaces: ["a/A.csproj", "b/B.csproj"] },
    });
    const scratch = { dir: null as string | null };
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runDotNetStep({
        ctx: { mode: "no-fix", repoRoot, scratch },
        trackedFiles: ["a/A.csproj", "b/B.csproj"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    assert.ok((result.notice ?? "").includes("2 workspace(s)"));
    // Each workspace is restored, format-checked, built and tested, in the
    // declared order: (verb, project) pairs, ignoring flags and cwd.
    const phases = calls.map(([cmd, verb, ...rest]) => {
        const project = rest.find((arg) => arg.endsWith(".csproj"));
        return `${cmd} ${verb} ${project?.slice(scratch.dir!.length + 1) ?? ""}`.trim();
    });
    assert.deepEqual(phases, [
        "dotnet restore a/A.csproj",
        "dotnet restore b/B.csproj",
        "dotnet format a/A.csproj",
        "dotnet build a/A.csproj",
        "dotnet test a/A.csproj",
        "dotnet format b/B.csproj",
        "dotnet build b/B.csproj",
        "dotnet test b/B.csproj",
    ]);
    cleanupScratch(scratch);
});

test("a failing declared workspace names itself and stops the run", async () => {
    // Arrange
    const repoRoot = await makeTwoProjectRepo();
    await writeConfig(repoRoot, {
        dotnet: { workspaces: ["a/A.csproj", "b/B.csproj"] },
    });
    const scratch = { dir: null as string | null };
    const calls: string[][] = [];
    const runner = (async ({
        cmd,
        args,
        cwd,
    }: {
        cmd: string;
        args: string[];
        cwd?: string;
    }) => {
        calls.push([cmd, ...args, cwd ?? ""]);
        const buildB =
            args[0] === "build" && (args[1] ?? "").includes("B.csproj");
        return buildB
            ? { status: 1, stdout: "", stderr: "boom" }
            : { status: 0, stdout: "", stderr: "" };
    }) as typeof import("../../lib/proc.mts").run;

    // Act
    const result = await runDotNetStep({
        ctx: { mode: "no-fix", repoRoot, scratch },
        trackedFiles: ["a/A.csproj", "b/B.csproj"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(result.notice ?? "", /dotnet: build failed \[b\/B\.csproj\]/u);
    const testedA = calls.some(
        (call) => call[0] === "dotnet" && call[1] === "test",
    );
    assert.equal(testedA, true, "the first workspace completed its checks");
    cleanupScratch(scratch);
});

test("a failing format check names its workspace", async () => {
    // Arrange
    const repoRoot = await makeTwoProjectRepo();
    await writeConfig(repoRoot, {
        dotnet: { workspaces: ["a/A.csproj", "b/B.csproj"] },
    });
    const scratch = { dir: null as string | null };
    const calls: string[][] = [];
    const runner = (async ({
        cmd,
        args,
        cwd,
    }: {
        cmd: string;
        args: string[];
        cwd?: string;
    }) => {
        calls.push([cmd, ...args, cwd ?? ""]);
        const formatB =
            args[0] === "format" &&
            args.some((arg) => arg.includes("B.csproj"));
        return formatB
            ? { status: 1, stdout: "", stderr: "diff" }
            : { status: 0, stdout: "", stderr: "" };
    }) as typeof import("../../lib/proc.mts").run;

    // Act
    const result = await runDotNetStep({
        ctx: { mode: "no-fix", repoRoot, scratch },
        trackedFiles: ["a/A.csproj", "b/B.csproj"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(
        result.notice ?? "",
        /dotnet: format found diffs \[b\/B\.csproj\] \(run with --fix\)/u,
    );
    const builtB = calls.some(
        (call) =>
            call[1] === "build" && call.some((arg) => arg.includes("B.csproj")),
    );
    assert.equal(builtB, false, "the run stops at the first failing workspace");
    cleanupScratch(scratch);
});

test("a declared workspace outside the git scope fails before restore", async () => {
    // Arrange
    const repoRoot = await makeDotnetRepo();
    await writeConfig(repoRoot, {
        dotnet: { workspaces: ["missing/C.csproj"] },
    });
    const scratch = { dir: null as string | null };
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runDotNetStep({
        ctx: { mode: "no-fix", repoRoot, scratch },
        trackedFiles: ["MyProj.csproj"],
        runner,
    });

    // Assert
    assert.equal(result.status, "fail");
    assert.match(
        result.notice ?? "",
        /declared workspace not in the git scope: missing\/C\.csproj/u,
    );
    assert.deepEqual(calls, []);
    cleanupScratch(scratch);
});

test("declared workspaces restore and format each in fix mode", async () => {
    // Arrange
    const repoRoot = await makeTwoProjectRepo();
    await writeConfig(repoRoot, {
        dotnet: { workspaces: ["a/A.csproj", "b/B.csproj"] },
    });
    const { runner, calls } = fakeRunner({}, true);

    // Act
    const result = await runDotNetStep({
        ctx: { mode: "fix", repoRoot },
        trackedFiles: ["a/A.csproj", "b/B.csproj"],
        runner,
    });

    // Assert
    assert.equal(result.status, "pass");
    assert.deepEqual(
        calls.map(([cmd, verb]) => `${cmd} ${verb}`),
        ["dotnet restore", "dotnet format", "dotnet restore", "dotnet format"],
    );
});
