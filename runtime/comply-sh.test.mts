// Tests for runtime/comply.sh: the source-development shim behind
// `cli/defined`'s source-repo delegation. Like the launcher suite, a fake
// engine and a fake git are injected on PATH, so no container, image, network
// or real repository is needed.
// Run: node --test runtime/comply-sh.test.mts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const SHIM = resolve(import.meta.dirname, "comply.sh");

interface ShimRun {
    status: number;
    stdout: string;
    stderr: string;
    log: string[];
    /** What the fake engine saw at FAKE_RUN_OBSERVE when `run` was invoked. */
    observed: string[];
}

interface Fixture {
    root: string;
    bin: string;
    repo: string;
}

/** The launching user's uid, as the fake engine reports a mount point. */
function hostUid(): string {
    const uid = process.getuid?.();
    assert.ok(uid !== undefined, "the shim is POSIX-only");
    return String(uid);
}

/**
 * Write the fake engine: `image inspect` reports the image present (so the shim
 * never builds), and `run` records its argv, what it found at
 * FAKE_RUN_OBSERVE, then exits with FAKE_RUN_EXIT when that is set.
 */
async function fakeEngine(
    bin: string,
    env: Record<string, string> = {},
): Promise<void> {
    const envAssign = Object.entries(env)
        .map(([k, v]) => `export ${k}="${v}"`)
        .join("\n");
    const script = `#!/usr/bin/env bash
${envAssign}
printf '%s\\n' "$*" >> "${join(bin, "podman.log")}"
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
    exit 0
fi
if [[ "$1" == "run" ]]; then
    if [[ -n "\${FAKE_RUN_OBSERVE:-}" ]]; then
        if [[ -d "\${FAKE_RUN_OBSERVE}" ]]; then
            printf 'present:%s:%s\\n' "$(stat -c %u "\${FAKE_RUN_OBSERVE}")" "$(ls -A "\${FAKE_RUN_OBSERVE}" | wc -l)" >> "${join(bin, "observe.log")}"
        else
            printf 'absent:0:0\\n' >> "${join(bin, "observe.log")}"
        fi
    fi
    if [[ -n "\${FAKE_RUN_EXIT:-}" ]]; then
        exit "\${FAKE_RUN_EXIT}"
    fi
fi
exit 0
`;
    const path = join(bin, "podman");
    await writeFile(path, script);
    await chmod(path, 0o755);
}

/** Write a fake git that always reports `repo` as the top-level. */
async function fakeGit(bin: string, repo: string): Promise<void> {
    const script = `#!/usr/bin/env bash
if [[ "$*" == *"rev-parse --show-toplevel"* ]]; then
    echo "${repo}"
    exit 0
fi
exit 1
`;
    const path = join(bin, "git");
    await writeFile(path, script);
    await chmod(path, 0o755);
}

/** Write a fake git that cannot resolve a top-level, as outside a checkout. */
async function fakeGitRefusing(bin: string): Promise<void> {
    const script = `#!/usr/bin/env bash
exit 1
`;
    const path = join(bin, "git");
    await writeFile(path, script);
    await chmod(path, 0o755);
}

/** Run the shim against a fresh fixture, always cleaning up. */
/**
 * Run a test body against a fresh fixture (fake bin + repo + fake git), always
 * cleaning up. The fake engine is written by each test, since its env carries
 * paths that only exist once the fixture root is known.
 */
async function withFixture(
    fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "defined-shim-"));
    const bin = join(root, "bin");
    const repo = join(root, "repo");
    await mkdir(bin);
    await mkdir(repo);
    await fakeGit(bin, repo);
    try {
        await fn({ root, bin, repo });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

/** Invoke the shim with the fakes ahead of the real PATH. */
async function runShim(fixture: Fixture, args: string[]): Promise<ShimRun> {
    const result = spawnSync(SHIM, args, {
        cwd: fixture.repo,
        encoding: "utf8",
        env: {
            ...process.env,
            PATH: [fixture.bin, process.env.PATH ?? ""].join(":"),
        },
    });
    const read = async (name: string): Promise<string[]> => {
        try {
            const content = await readFile(join(fixture.bin, name), "utf8");
            return content.trim().split("\n").filter(Boolean);
        } catch {
            return [];
        }
    };
    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        log: await read("podman.log"),
        observed: await read("observe.log"),
    };
}

/** The repo hash the shim keys its named volumes by. */
function repoHash(repo: string): string {
    return createHash("sha256").update(repo).digest("hex").slice(0, 12);
}

test("writes one JSON error line when run outside a git repository", async () => {
    await withFixture(async (fixture) => {
        // Arrange — a git that cannot resolve a top level, as outside a checkout.
        await fakeGitRefusing(fixture.bin);

        // Act
        const r = await runShim(fixture, []);

        // Assert — the stdout contract holds even when there is no repo.
        assert.equal(r.status, 1);
        const parsed = JSON.parse(r.stdout) as {
            status: string;
            errors?: { check?: string; message?: string }[];
        };
        assert.equal(parsed.status, "error");
        assert.equal(parsed.errors?.[0]?.check, "git");
        assert.match(r.stderr, /not inside a git repository/u);
    });
});

test("creates the deps mount point as the host user, then removes it", async () => {
    await withFixture(async (fixture) => {
        // Arrange
        const deps = join(fixture.repo, "node_modules");
        await fakeEngine(fixture.bin, { FAKE_RUN_OBSERVE: deps });

        // Act
        const r = await runShim(fixture, []);

        // Assert
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(r.observed, [`present:${hostUid()}:0`]);
        await assert.rejects(
            stat(deps),
            "the shim's own mount point must not persist",
        );
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.match(
            run!,
            new RegExp(
                `-v defined-node-[0-9a-f]{12}-${repoHash(fixture.repo)}:/repo/node_modules( |$)`,
                "u",
            ),
        );
    });
});

test("mounts no deps volume and creates no mount point for explain", async () => {
    await withFixture(async (fixture) => {
        // Arrange
        const deps = join(fixture.repo, "node_modules");
        await fakeEngine(fixture.bin, { FAKE_RUN_OBSERVE: deps });

        // Act
        const r = await runShim(fixture, ["explain", "shell"]);

        // Assert
        assert.equal(r.status, 0, r.stderr);
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(run, "explain must invoke the engine");
        assert.doesNotMatch(run!, /defined-node-/u, "explain writes nothing");
        assert.deepEqual(r.observed, ["absent:0:0"]);
        await assert.rejects(stat(deps));
    });
});

test("passes the scan verb through to the gate with its flags", async () => {
    await withFixture(async (fixture) => {
        // Arrange
        await fakeEngine(fixture.bin, {});

        // Act
        const r = await runShim(fixture, ["scan", "--full"]);

        // Assert
        assert.equal(r.status, 0, r.stderr);
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(run, "scan must invoke the engine");
        assert.match(run!, /scan --full$/u);
        assert.doesNotMatch(
            run!,
            /--check-only/u,
            "scan is verbatim, not a check-only alias",
        );
    });
});

test("propagates the gate's exit status", async () => {
    await withFixture(async (fixture) => {
        // Arrange
        await fakeEngine(fixture.bin, { FAKE_RUN_EXIT: "4" });

        // Act
        const r = await runShim(fixture, []);

        // Assert
        assert.equal(r.status, 4);
    });
});

test("removes its mount point even when the run fails", async () => {
    await withFixture(async (fixture) => {
        // Arrange
        const deps = join(fixture.repo, "node_modules");
        await fakeEngine(fixture.bin, {
            FAKE_RUN_OBSERVE: deps,
            FAKE_RUN_EXIT: "4",
        });

        // Act
        const r = await runShim(fixture, []);

        // Assert
        assert.equal(r.status, 4);
        await assert.rejects(
            stat(deps),
            "cleanup must not depend on the run succeeding",
        );
    });
});

test("warns when an existing deps mount point is not writable", async (t) => {
    if (process.getuid?.() === 0) {
        t.skip(
            "root writes through any mode, so the condition cannot be built",
        );
        return;
    }
    await withFixture(async (fixture) => {
        // Arrange
        const deps = join(fixture.repo, "node_modules");
        await fakeEngine(fixture.bin, {});
        await mkdir(deps);
        await chmod(deps, 0o555);
        try {
            // Act
            const r = await runShim(fixture, []);

            // Assert
            assert.equal(r.status, 0, r.stderr);
            assert.match(r.stderr, /not writable/u);
            assert.match(r.stderr, /node_modules/u);
            // Not ours to remove: the run leaves it exactly as it found it.
            assert.equal((await stat(deps)).isDirectory(), true);
        } finally {
            await chmod(deps, 0o755);
        }
    });
});
