// Tests for cli/scan.sh: the install-less entry point (cached launcher + scan).
//
// The script is bash; tests drive it with a fake curl serving the real
// cli/defined (so the embedded checksum stays a real pair), plus fake
// engine/git executables on PATH. No network, engine or real repository is
// needed. Run: node --test cli/scan.test.mts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmod,
    mkdtemp,
    mkdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const LAUNCHER = resolve(import.meta.dirname, "defined");
const SCAN_SH = resolve(import.meta.dirname, "scan.sh");

/** The launcher's sha256, as the script must embed it. */
async function launcherSha(): Promise<string> {
    return createHash("sha256")
        .update(await readFile(LAUNCHER))
        .digest("hex");
}

interface Fixture {
    root: string;
    home: string;
    cache: string;
    bin: string;
    repo: string;
    /** Served launcher file the fake curl copies to its `-o` destination. */
    served: string;
}

interface ScanRun {
    status: number;
    stdout: string;
    stderr: string;
    log: string[];
    curlLog: string[];
}

async function writeExecutable(path: string, script: string): Promise<void> {
    await writeFile(path, script);
    await chmod(path, 0o755);
}

/** Fake curl: copies fixture.served to `-o <dest>`, logging each URL. */
async function fakeCurl(bin: string, served: string): Promise<void> {
    await writeExecutable(
        join(bin, "curl"),
        `#!/usr/bin/env bash
dest=""
url=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o)
            dest="$2"
            shift 2
            ;;
        *)
            url="$1"
            shift
            ;;
    esac
done
printf '%s\\n' "\${url}" >> "${join(bin, "curl.log")}"
cp "${served}" "\${dest}"
`,
    );
}

/** Fake engine: inspect/pull succeed; `run` records its argv and exits 0. */
async function fakeEngine(bin: string): Promise<void> {
    await writeExecutable(
        join(bin, "podman"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(bin, "podman.log")}"
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
    exit 0
fi
exit 0
`,
    );
}

/** Fake git: reports fixture.repo as the top-level and no remotes. */
async function fakeGit(bin: string, repo: string): Promise<void> {
    await writeExecutable(
        join(bin, "git"),
        `#!/usr/bin/env bash
if [[ "$*" == *"rev-parse --show-toplevel"* ]]; then
    echo "${repo}"
    exit 0
fi
exit 1
`,
    );
}

async function makeFixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "defined-scan-"));
    const home = join(root, "home");
    const cache = join(root, "cache");
    const bin = join(root, "bin");
    const repo = join(root, "repo");
    const served = join(root, "served-defined");
    await mkdir(home);
    await mkdir(bin);
    await mkdir(repo);
    await writeFile(served, await readFile(LAUNCHER));
    await fakeCurl(bin, served);
    await fakeEngine(bin);
    await fakeGit(bin, repo);
    return { root, home, cache, bin, repo, served };
}

async function withFixture<T>(
    fn: (fixture: Fixture) => Promise<T>,
): Promise<T> {
    const fixture = await makeFixture();
    try {
        return await fn(fixture);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
}

/** Drop the fake-engine and downloader logs so a run starts clean. */
async function resetLogs(fixture: Fixture): Promise<void> {
    await rm(join(fixture.bin, "podman.log"), { force: true });
    await rm(join(fixture.bin, "curl.log"), { force: true });
}

async function readLines(path: string): Promise<string[]> {
    try {
        const content = await readFile(path, "utf8");
        return content.trim().split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

async function runScan({
    fixture,
    args,
    env = {},
}: {
    fixture: Fixture;
    args: string[];
    env?: Record<string, string>;
}): Promise<ScanRun> {
    const result = spawnSync("bash", [SCAN_SH, ...args], {
        cwd: fixture.repo,
        encoding: "utf8",
        env: {
            ...process.env,
            HOME: fixture.home,
            XDG_CACHE_HOME: fixture.cache,
            PATH: [fixture.bin, process.env.PATH ?? ""].join(":"),
            ...env,
        },
    });
    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        log: await readLines(join(fixture.bin, "podman.log")),
        curlLog: await readLines(join(fixture.bin, "curl.log")),
    };
}

/** The cache entry the content hash selects. */
async function cachedPath(fixture: Fixture): Promise<string> {
    const sha = await launcherSha();
    return join(fixture.cache, "defined", `launcher-${sha.slice(0, 12)}`);
}

test("downloads the launcher once, caches it, and runs scan with the flags", async () => {
    await withFixture(async (fixture) => {
        // Act
        const r = await runScan({ fixture, args: ["--full", "--timings"] });

        // Assert
        assert.equal(r.status, 0, r.stderr);
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(run, "scan must invoke the engine");
        assert.ok(
            run!.endsWith(" scan --full --timings"),
            `flags must reach scan untouched, got: ${run}`,
        );
        assert.equal(r.curlLog.length, 1, "one download on a cold cache");
        assert.match(r.curlLog[0]!, /\/main\/cli\/defined$/u);

        const cached = await cachedPath(fixture);
        assert.equal(
            await readFile(cached, "utf8"),
            await readFile(LAUNCHER, "utf8"),
            "the cached copy is the published launcher",
        );
        assert.equal((await stat(cached)).mode & 0o777, 0o755);
    });
});

test("reuses the cached launcher instead of downloading again", async () => {
    await withFixture(async (fixture) => {
        // Arrange
        await runScan({ fixture, args: [] });
        await resetLogs(fixture);

        // Act
        const r = await runScan({ fixture, args: [] });

        // Assert
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(r.curlLog, [], "a warm cache downloads nothing");
        assert.ok(r.log.some((line) => line.startsWith("run --rm")));
    });
});

test("--refresh re-downloads and replaces the cached launcher", async () => {
    await withFixture(async (fixture) => {
        // Arrange
        await runScan({ fixture, args: [] });
        await resetLogs(fixture);

        // Act
        const r = await runScan({ fixture, args: ["--refresh"] });

        // Assert
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.curlLog.length, 1, "--refresh forces a download");
        assert.ok(
            r.log.some((line) => line.endsWith(" scan")),
            "--refresh is consumed, not forwarded",
        );
    });
});

test("refuses a launcher that does not match the checksum", async () => {
    await withFixture(async (fixture) => {
        // Arrange
        await writeFile(
            fixture.served,
            `${await readFile(LAUNCHER, "utf8")}\n# tampered\n`,
        );

        // Act
        const r = await runScan({ fixture, args: [] });

        // Assert
        assert.equal(r.status, 1);
        assert.match(r.stderr, /checksum mismatch/u);
        assert.deepEqual(r.log, [], "no engine runs on a bad download");
        await assert.rejects(
            stat(await cachedPath(fixture)),
            "a mismatched launcher is never cached",
        );
    });
});

test("help prints usage and downloads nothing", async () => {
    await withFixture(async (fixture) => {
        // Act
        const r = await runScan({ fixture, args: ["--help"] });

        // Assert
        assert.equal(r.status, 0);
        assert.match(r.stderr, /usage:/u);
        assert.deepEqual(r.curlLog, []);
        assert.deepEqual(r.log, []);
    });
});

test("falls back to HOME/.cache when XDG_CACHE_HOME is unset", async () => {
    await withFixture(async (fixture) => {
        // Act — passing an empty XDG_CACHE_HOME is not the same as unsetting it,
        // so override it out of the environment rather than blanking the value.
        const result = spawnSync("bash", [SCAN_SH], {
            cwd: fixture.repo,
            encoding: "utf8",
            env: {
                HOME: fixture.home,
                PATH: [fixture.bin, process.env.PATH ?? ""].join(":"),
            },
        });

        // Assert
        assert.equal(result.status, 0, result.stderr ?? "");
        const sha = await launcherSha();
        const cached = join(
            fixture.home,
            ".cache",
            "defined",
            `launcher-${sha.slice(0, 12)}`,
        );
        assert.equal(
            await readFile(cached, "utf8"),
            await readFile(LAUNCHER, "utf8"),
        );
    });
});

test("the embedded checksum matches cli/defined", async () => {
    // Arrange
    const expected = await launcherSha();
    const script = await readFile(SCAN_SH, "utf8");
    const match = /^LAUNCHER_SHA256="([0-9a-f]{64})"$/mu.exec(script);

    // Assert
    assert.ok(match, "scan.sh must declare LAUNCHER_SHA256");
    assert.equal(
        match[1],
        expected,
        "cli/defined changed: update LAUNCHER_SHA256 in cli/scan.sh",
    );
});
