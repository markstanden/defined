// Tests for cli/defined: the installed host launcher (decision #25).
//
// The launcher is bash; unit tests inject fake `podman`/`docker`/`git`
// executables on PATH (no real engine needed) and assert on the recorded
// invocations. Each fake writes its argv to a log file, so engine choice,
// mount modes, image selection and arg forwarding are all observable.
// Run: node --test cli/defined.test.mts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    chmod,
    mkdtemp,
    mkdir,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const LAUNCHER = resolve(import.meta.dirname, "defined");
const INSTALL_SH = resolve(import.meta.dirname, "install.sh");
const IMAGE_REPO = "ghcr.io/markstanden/defined";

/** Full remote revision whose 12-char prefix is the pin used in tests. */
const REMOTE_REV = "87fe682a2339fa854560a286276e831df71a8ab5";
const PIN = REMOTE_REV.slice(0, 12);
const LAUNCHER_SHORT = REMOTE_REV.slice(0, 7);
/** A stale revision, used to prove the drift verdicts. */
const STALE_REV = "3f9c1a2" + "0".repeat(33);

/** True when some output line contains every given fragment. */
function hasLine(stdout: string, ...fragments: string[]): boolean {
    return stdout
        .split("\n")
        .some((line) => fragments.every((fragment) => line.includes(fragment)));
}

interface LauncherRun {
    status: number;
    stdout: string;
    stderr: string;
    log: string[];
    curlLog: string[];
}

interface Fixture {
    root: string;
    bin: string;
    repo: string;
    /** Where `update` installs the launcher (DEFINED_BIN_DIR). */
    install: string;
    /** A fake raw.githubusercontent.com checkout served by fake curl. */
    remote: string;
}

/**
 * Temp dir + fake bin + a git repo containing the given .defined.json.
 * `pin` is either a version string, a full config object (for versionless
 * configs), or undefined (no .defined.json at all).
 */
async function makeFixture(
    pin?: string | Record<string, unknown>,
): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "quality-launcher-"));
    const bin = join(root, "bin");
    const repo = join(root, "repo");
    const install = join(root, "install");
    const remote = join(root, "remote");
    await mkdir(bin);
    await mkdir(repo);
    await mkdir(install);
    await mkdir(join(remote, "cli"), { recursive: true });
    // The fake downloader serves the real launcher + installer, so the
    // installer's embedded checksum and the launcher bytes stay a matched pair.
    await writeFile(join(remote, "cli", "defined"), await readFile(LAUNCHER));
    await writeFile(
        join(remote, "cli", "install.sh"),
        await readFile(INSTALL_SH),
    );
    if (typeof pin === "string") {
        await writeFile(
            join(repo, ".defined.json"),
            `${JSON.stringify({ version: pin })}\n`,
        );
    } else if (pin !== undefined) {
        await writeFile(
            join(repo, ".defined.json"),
            `${JSON.stringify(pin)}\n`,
        );
    }
    return { root, bin, repo, install, remote };
}

/** Run a test body against a fresh fixture, always cleaning up. */
async function withFixture<T>(
    pin: string | Record<string, unknown> | undefined,
    fn: (fixture: Fixture) => Promise<T>,
): Promise<T> {
    const fixture = await makeFixture(pin);
    try {
        return await fn(fixture);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
}

/**
 * Write a fake engine (podman/docker). Behaviour is controlled by env vars
 * read from its own environment at invocation time:
 *   FAKE_INSPECT_FAIL=1   → `image inspect` exits 1 (image absent)
 *   FAKE_DIGEST=<digest>  → printed by `image inspect --format ...`
 *   FAKE_MANIFEST_FAIL=1  → `manifest inspect` exits 1 (tag unknown/offline)
 *   FAKE_MANIFEST_ERROR=… → the failure message (default "manifest unknown")
 *   FAKE_PULL_FAIL=1      → `pull` exits 1 (offline)
 *   FAKE_NO_ENGINE=1      → `--version`/inspect succeed but do nothing
 * Every invocation is appended to <bin>/<name>.log as a single line.
 */
async function fakeEngine(
    bin: string,
    name: string,
    env: Record<string, string> = {},
): Promise<void> {
    const logPath = join(bin, `${name}.log`);
    const envAssign = Object.entries(env)
        .map(([k, v]) => `export ${k}="${v}"`)
        .join("\n");
    const script = `#!/usr/bin/env bash
${envAssign}
printf '%s\\n' "$*" >> "${logPath}"
if [[ "$1" == "--version" ]]; then
    echo "${name} version 9.9.9"
    exit 0
fi
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
    if [[ "\${FAKE_INSPECT_FAIL:-0}" == "1" ]]; then
        exit 1
    fi
    echo "\${FAKE_DIGEST:-}"
    exit 0
fi
if [[ "$1" == "manifest" && "$2" == "inspect" ]]; then
    if [[ "\${FAKE_MANIFEST_FAIL:-0}" == "1" ]]; then
        echo "\${FAKE_MANIFEST_ERROR:-manifest unknown}" >&2
        exit 1
    fi
    exit 0
fi
if [[ "$1" == "pull" ]]; then
    [[ "\${FAKE_PULL_FAIL:-0}" == "1" ]] && exit 1 || exit 0
fi
exit 0
`;
    const path = join(bin, name);
    await writeFile(path, script);
    await chmod(path, 0o755);
}

/**
 * Symlink the coreutils the launcher needs into the fake bin so a bare PATH
 * (used to prove the no-engine path) still resolves basename/tr/cut/sha256sum
 * without exposing a real container engine.
 */
async function symlinkTools(bin: string): Promise<void> {
    for (const tool of [
        "bash",
        "basename",
        "cut",
        "readlink",
        "sed",
        "sha256sum",
        "tr",
    ]) {
        const link = join(bin, tool);
        try {
            await symlink(`/usr/bin/${tool}`, link);
        } catch {
            // Already linked (a fixture reused by a second run) — fine.
        }
    }
}

/** Write a fake git that always reports `repo` as the top-level. */
async function fakeGit(bin: string, repo: string): Promise<void> {
    const script = `#!/usr/bin/env bash
if [[ "$*" == *"rev-parse --show-toplevel"* ]]; then
    if [[ "\${FAKE_GIT_NO_REPO:-0}" == "1" ]]; then
        exit 1
    fi
    echo "${repo}"
    exit 0
fi
if [[ "$*" == *"ls-remote"* ]]; then
    if [[ -n "\${FAKE_REMOTE_REV:-}" ]]; then
        printf '%s\\trefs/heads/main\\n' "\${FAKE_REMOTE_REV}"
        exit 0
    fi
    exit 1
fi
if [[ "$*" == *"remote get-url"* ]]; then
    if [[ -n "\${FAKE_GIT_REMOTE:-}" && "\${!#}" == "\${FAKE_GIT_REMOTE}" ]]; then
        echo "\${FAKE_GIT_REMOTE_URL:-}"
        exit 0
    fi
    exit 1
fi
if [[ "$*" == *" remote" ]]; then
    if [[ -n "\${FAKE_GIT_REMOTE:-}" ]]; then
        echo "\${FAKE_GIT_REMOTE}"
    fi
    exit 0
fi
exit 1
`;
    const path = join(bin, "git");
    await writeFile(path, script);
    await chmod(path, 0o755);
}

/**
 * Write a fake curl that serves `<remote>/cli/<basename-of-url>` to the `-o`
 * destination, recording each requested URL in <bin>/curl.log. This mirrors the
 * raw.githubusercontent.com layout that `update` fetches from.
 */
async function fakeCurl(bin: string, remote: string): Promise<void> {
    const script = `#!/usr/bin/env bash
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
name="\${url##*/}"
src="${remote}/cli/\${name}"
if [[ ! -f "\${src}" ]]; then
    exit 1
fi
cp "\${src}" "\${dest}"
`;
    const path = join(bin, "curl");
    await writeFile(path, script);
    await chmod(path, 0o755);
}

/**
 * Install a launcher copy with a baked revision, exactly as cli/install.sh
 * writes it, so the revision-dependent `version` verdicts are testable.
 */
async function bakeLauncher(fixture: Fixture, rev: string): Promise<string> {
    const source = await readFile(LAUNCHER, "utf8");
    const baked = source.replace(
        /^LAUNCHER_REV=""$/mu,
        `LAUNCHER_REV="${rev}"`,
    );
    assert.notEqual(baked, source, "the LAUNCHER_REV slot must exist");
    const path = join(fixture.bin, "defined");
    await writeFile(path, baked);
    await chmod(path, 0o755);
    return path;
}

/**
 * Run the launcher against the fixture with fake engines + git on PATH.
 * When `barePath` is set, PATH contains ONLY the fixture bin dir (plus any
 * engine fakes added), isolating the launcher from host binaries.
 */
async function runLauncher({
    fixture,
    args,
    engines = ["podman"],
    env = {},
    barePath = false,
    launcher = LAUNCHER,
    cwd,
}: {
    fixture: Fixture;
    args: string[];
    engines?: string[];
    env?: Record<string, string>;
    barePath?: boolean;
    launcher?: string;
    cwd?: string;
}): Promise<LauncherRun> {
    for (const engine of engines) {
        await fakeEngine(fixture.bin, engine, env);
    }
    await fakeGit(fixture.bin, fixture.repo);
    await fakeCurl(fixture.bin, fixture.remote);
    await symlinkTools(fixture.bin);
    // Logs are appended by the fakes; truncate so each run is self-contained
    // (a fixture may be reused by a second runLauncher call).
    for (const engine of engines) {
        await rm(join(fixture.bin, `${engine}.log`), { force: true });
    }
    await rm(join(fixture.bin, "curl.log"), { force: true });

    const path = barePath
        ? fixture.bin
        : [fixture.bin, process.env.PATH ?? ""].join(":");
    const result = spawnSync(launcher, args, {
        cwd: cwd ?? fixture.repo,
        encoding: "utf8",
        env: {
            ...(barePath ? {} : process.env),
            PATH: path,
            ...env,
        },
    });
    const log: string[] = [];
    for (const engine of engines) {
        try {
            const content = await readFile(
                join(fixture.bin, `${engine}.log`),
                "utf8",
            );
            log.push(...content.trim().split("\n").filter(Boolean));
        } catch {
            // engine not invoked
        }
    }
    const curlLog: string[] = [];
    try {
        const content = await readFile(join(fixture.bin, "curl.log"), "utf8");
        curlLog.push(...content.trim().split("\n").filter(Boolean));
    } catch {
        // downloader not invoked
    }
    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        log,
        curlLog,
    };
}

test("prefers podman over docker", async () => {
    await withFixture("abc12345", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["verify"],
            engines: ["podman", "docker"],
        });
        assert.equal(r.status, 0);
        const runs = r.log.filter((line) => line.startsWith("run --rm"));
        assert.equal(
            runs.length,
            1,
            "only podman runs, docker is never called",
        );
        assert.match(runs[0]!, new RegExp(`${IMAGE_REPO}:abc12345 verify$`));
    });
});

test("fails loudly when no engine is available", async () => {
    await withFixture("abc12345", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["verify"],
            engines: [],
            barePath: true,
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /no container engine found/u);
        assert.deepEqual(r.log, []);
    });
});

test("resolves the repo root via git and mounts it for comply", async () => {
    await withFixture("abc12345", async (fixture) => {
        const r = await runLauncher({ fixture, args: ["comply"] });
        assert.equal(r.status, 0);
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(run, "comply must invoke the engine");
        assert.match(run!, new RegExp(`-v ${fixture.repo}:/repo( |$)`));
        assert.doesNotMatch(run!, /:ro/);
        assert.ok(run!.endsWith(`${IMAGE_REPO}:abc12345 comply`));
    });
});

test("mounts the repo read-only for verify", async () => {
    await withFixture("abc12345", async (fixture) => {
        const r = await runLauncher({ fixture, args: ["verify"] });
        assert.equal(r.status, 0);
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(run, "verify must invoke the engine");
        assert.match(run!, new RegExp(`-v ${fixture.repo}:/repo:ro`));
        assert.ok(run!.endsWith(`${IMAGE_REPO}:abc12345 verify`));
    });
});

test("pulls the exact pinned image when it is not present locally", async () => {
    await withFixture("feedface", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["verify"],
            env: { FAKE_INSPECT_FAIL: "1" },
        });
        assert.equal(r.status, 0);
        assert.ok(
            r.log.some((line) =>
                line.startsWith(`image inspect ${IMAGE_REPO}:feedface`),
            ),
        );
        assert.ok(
            r.log.some((line) =>
                line.startsWith(`pull ${IMAGE_REPO}:feedface`),
            ),
        );
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(run!.includes(`${IMAGE_REPO}:feedface`));
    });
});

test("does not pull when the image is already present", async () => {
    await withFixture("feedface", async (fixture) => {
        const r = await runLauncher({ fixture, args: ["verify"] });
        assert.equal(r.status, 0);
        assert.ok(
            r.log.some((line) =>
                line.startsWith(`image inspect ${IMAGE_REPO}:feedface`),
            ),
        );
        assert.ok(
            !r.log.some((line) => line.startsWith("pull")),
            "no pull when the image is present",
        );
    });
});

test("fails when the pinned image cannot be pulled", async () => {
    await withFixture("feedface", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["verify"],
            env: { FAKE_INSPECT_FAIL: "1", FAKE_PULL_FAIL: "1" },
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /unavailable/u);
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(!run, "no run when the image cannot be fetched");
    });
});

test("rejects mutable and malformed pins", async () => {
    for (const pin of ["latest", "main", "dead-beef", "DEADBEEF", "v1.2.3"]) {
        await withFixture(pin, async (fixture) => {
            const r = await runLauncher({ fixture, args: ["verify"] });
            assert.equal(r.status, 1, `pin '${pin}' must be rejected`);
            assert.match(r.stderr, /immutable|invalid pin/u);
            assert.deepEqual(r.log, [], "no engine run for a bad pin");
        });
    }
});

test("defaults to the latest image when config is missing, empty or versionless", async () => {
    // Missing .defined.json → default latest, no error.
    await withFixture(undefined, async (missing) => {
        const r = await runLauncher({ fixture: missing, args: ["verify"] });
        assert.equal(r.status, 0);
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(run, "default must still run the engine");
        assert.ok(run!.endsWith(`${IMAGE_REPO}:latest verify`));
    });

    // Empty/whitespace-only file → no version extracted → default latest.
    await withFixture("abc12345", async (blank) => {
        await writeFile(join(blank.repo, ".defined.json"), "\n  \n");
        const r = await runLauncher({ fixture: blank, args: ["verify"] });
        assert.equal(r.status, 0);
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(run!.endsWith(`${IMAGE_REPO}:latest verify`));
    });

    // Versionless config (coverage only) → default latest, coverage preserved.
    await withFixture({ coverage: {} }, async (noVersion) => {
        const r = await runLauncher({ fixture: noVersion, args: ["verify"] });
        assert.equal(r.status, 0);
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(run!.endsWith(`${IMAGE_REPO}:latest verify`));
    });
});

test("reports an unknown revision for a hand-installed launcher", async () => {
    await withFixture("abc12345", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["--version"],
            engines: [],
        });
        assert.equal(r.status, 0);
        assert.equal(r.stdout, "defined unknown\n");
        assert.deepEqual(r.log, [], "no engine is needed to report a version");
    });
});

test("forwards unknown verbs to usage and exits non-zero", async () => {
    await withFixture("abc12345", async (fixture) => {
        const r = await runLauncher({ fixture, args: ["setup"] });
        assert.equal(r.status, 2);
        assert.match(r.stderr, /usage/u);
        assert.deepEqual(r.log, []);
    });
});

test("honours DEFINED_ENGINE override", async () => {
    await withFixture("abc12345", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["verify"],
            engines: ["podman", "docker"],
            env: { DEFINED_ENGINE: "docker" },
        });
        assert.equal(r.status, 0);
        const runs = r.log.filter((line) => line.startsWith("run --rm"));
        assert.equal(runs.length, 1);
        // The override picks docker, whose log lives in docker.log.
        const dockerLog = await readFile(
            join(fixture.bin, "docker.log"),
            "utf8",
        );
        assert.ok(dockerLog.includes("run --rm"));
    });
});

test("offline mode runs the container with no network", async () => {
    await withFixture("abc12345", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["comply"],
            env: { DEFINED_OFFLINE: "1" },
        });
        assert.equal(r.status, 0);
        const run = r.log.find((line) => line.startsWith("run --rm"));
        assert.ok(run, "offline comply must still invoke the engine");
        assert.match(run!, /--network=none/);
    });
});

test("offline mode never pulls: a missing image fails loudly", async () => {
    await withFixture("abc12345", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["verify"],
            env: { DEFINED_OFFLINE: "1", FAKE_INSPECT_FAIL: "1" },
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /not present locally/u);
        assert.ok(
            !r.log.some((line) => line.startsWith("pull")),
            "offline mode must not attempt a network pull",
        );
        assert.ok(
            !r.log.some((line) => line.startsWith("run --rm")),
            "no run when the image is missing offline",
        );
    });
});

test("version reports launcher, pin, image, engine and drift", async () => {
    await withFixture(PIN, async (fixture) => {
        const launcher = await bakeLauncher(fixture, REMOTE_REV);
        const r = await runLauncher({
            fixture,
            args: ["version"],
            launcher,
            env: {
                FAKE_REMOTE_REV: REMOTE_REV,
                FAKE_DIGEST: "sha256:aa11bb22cc33dd44ee55",
            },
        });
        assert.equal(r.status, 0);
        assert.ok(
            hasLine(r.stdout, "launcher", launcher, `rev ${LAUNCHER_SHORT}`),
        );
        assert.ok(hasLine(r.stdout, "pin", `.defined.json -> ${PIN}`));
        assert.ok(hasLine(r.stdout, "image", `${IMAGE_REPO}:${PIN}`));
        assert.ok(hasLine(r.stdout, "local", "present sha256:aa11bb22cc33…"));
        assert.ok(hasLine(r.stdout, "remote", "present"));
        assert.ok(hasLine(r.stdout, "engine", "podman version 9.9.9"));
        assert.ok(hasLine(r.stdout, "status", "launcher current; pin current"));
    });
});

test("version marks a stale launcher and pin as behind", async () => {
    await withFixture(STALE_REV.slice(0, 12), async (fixture) => {
        const launcher = await bakeLauncher(fixture, STALE_REV);
        const r = await runLauncher({
            fixture,
            args: ["version"],
            launcher,
            env: { FAKE_REMOTE_REV: REMOTE_REV },
        });
        assert.equal(r.status, 0);
        assert.ok(hasLine(r.stdout, "status", "launcher behind; pin behind"));
    });
});

test("version degrades the remote state to unknown offline", async () => {
    await withFixture(PIN, async (fixture) => {
        const launcher = await bakeLauncher(fixture, REMOTE_REV);
        const r = await runLauncher({
            fixture,
            args: ["version"],
            launcher,
            env: { FAKE_REMOTE_REV: REMOTE_REV, DEFINED_OFFLINE: "1" },
        });
        assert.equal(r.status, 0);
        assert.ok(hasLine(r.stdout, "remote", "unknown"));
        assert.ok(hasLine(r.stdout, "status", "launcher unknown; pin unknown"));
    });
});

test("version distinguishes an absent tag from an unreachable registry", async () => {
    await withFixture(PIN, async (fixture) => {
        const launcher = await bakeLauncher(fixture, REMOTE_REV);
        const absent = await runLauncher({
            fixture,
            args: ["version"],
            launcher,
            env: {
                FAKE_REMOTE_REV: REMOTE_REV,
                FAKE_MANIFEST_FAIL: "1",
                FAKE_MANIFEST_ERROR: "manifest unknown",
            },
        });
        assert.ok(hasLine(absent.stdout, "remote", "absent"));

        const unreachable = await runLauncher({
            fixture,
            args: ["version"],
            launcher,
            env: {
                FAKE_REMOTE_REV: REMOTE_REV,
                FAKE_MANIFEST_FAIL: "1",
                FAKE_MANIFEST_ERROR: "dial tcp: connection refused",
            },
        });
        assert.ok(hasLine(unreachable.stdout, "remote", "unknown"));
    });
});

test("version reports an invalid pin without failing", async () => {
    await withFixture("main", async (fixture) => {
        const r = await runLauncher({ fixture, args: ["version"] });
        assert.equal(r.status, 0);
        assert.ok(hasLine(r.stdout, "pin", "(invalid pin 'main')"));
        assert.ok(hasLine(r.stdout, "image", "n/a"));
        assert.ok(hasLine(r.stdout, "status", "launcher unknown; pin invalid"));
    });
});

test("version works outside a repository", async () => {
    await withFixture(PIN, async (fixture) => {
        const launcher = await bakeLauncher(fixture, REMOTE_REV);
        const r = await runLauncher({
            fixture,
            args: ["version"],
            launcher,
            cwd: fixture.root,
            env: { FAKE_REMOTE_REV: REMOTE_REV, FAKE_GIT_NO_REPO: "1" },
        });
        assert.equal(r.status, 0);
        assert.ok(hasLine(r.stdout, "pin", "(no repository)"));
        assert.ok(hasLine(r.stdout, "image", "n/a"));
        assert.ok(hasLine(r.stdout, "status", "launcher current; pin n/a"));
    });
});

test("version reports no engine without failing", async () => {
    await withFixture(PIN, async (fixture) => {
        const launcher = await bakeLauncher(fixture, REMOTE_REV);
        const r = await runLauncher({
            fixture,
            args: ["version"],
            launcher,
            engines: [],
            barePath: true,
            env: { FAKE_REMOTE_REV: REMOTE_REV },
        });
        assert.equal(r.status, 0);
        assert.ok(hasLine(r.stdout, "engine", "none"));
        assert.ok(hasLine(r.stdout, "local", "unknown"));
        assert.ok(hasLine(r.stdout, "remote", "unknown"));
    });
});

test("update resolves latest and moves pin, launcher and image together", async () => {
    await withFixture({ coverage: { node: {} } }, async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["update"],
            env: {
                FAKE_REMOTE_REV: REMOTE_REV,
                FAKE_GIT_REMOTE: "origin",
                FAKE_GIT_REMOTE_URL: "https://github.com/me/app.git",
                FAKE_INSPECT_FAIL: "1",
                DEFINED_BIN_DIR: fixture.install,
            },
        });
        assert.equal(r.status, 0);

        const config = JSON.parse(
            await readFile(join(fixture.repo, ".defined.json"), "utf8"),
        );
        assert.equal(config.version, PIN);
        assert.deepEqual(config.coverage, { node: {} });

        const installed = join(fixture.install, "defined");
        const version = spawnSync(installed, ["--version"], {
            encoding: "utf8",
        });
        assert.equal(version.status, 0);
        assert.equal(version.stdout.trim(), `defined ${LAUNCHER_SHORT}`);

        assert.ok(r.log.some((line) => line === `pull ${IMAGE_REPO}:${PIN}`));
        assert.ok(
            r.curlLog.some((url) =>
                url.endsWith(`/${REMOTE_REV}/cli/install.sh`),
            ),
            "install.sh is fetched at the resolved revision",
        );
        assert.ok(
            r.curlLog.some((url) => url.endsWith(`/${REMOTE_REV}/cli/defined`)),
            "the installer fetches the launcher at the same revision",
        );
        assert.ok(hasLine(r.stdout, "update:", "working-tree change"));
    });
});

test("update accepts an explicit short SHA and replaces the pin", async () => {
    await withFixture("olddeadbeef0", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["update", PIN],
            env: {
                FAKE_GIT_REMOTE: "origin",
                FAKE_GIT_REMOTE_URL: "https://github.com/me/app.git",
                DEFINED_BIN_DIR: fixture.install,
            },
        });
        assert.equal(r.status, 0);
        const config = JSON.parse(
            await readFile(join(fixture.repo, ".defined.json"), "utf8"),
        );
        assert.equal(config.version, PIN);
        assert.ok(
            r.curlLog.some((url) => url.endsWith(`/${PIN}/cli/install.sh`)),
        );
    });
});

test("update is a no-op when everything is already current", async () => {
    await withFixture({ coverage: {} }, async (fixture) => {
        const baseEnv = {
            FAKE_REMOTE_REV: REMOTE_REV,
            FAKE_GIT_REMOTE: "origin",
            FAKE_GIT_REMOTE_URL: "https://github.com/me/app.git",
            DEFINED_BIN_DIR: fixture.install,
        };
        const first = await runLauncher({
            fixture,
            args: ["update"],
            env: { ...baseEnv, FAKE_INSPECT_FAIL: "1" },
        });
        assert.equal(first.status, 0);
        assert.ok(
            first.log.some((line) => line === `pull ${IMAGE_REPO}:${PIN}`),
        );

        const before = await readFile(
            join(fixture.repo, ".defined.json"),
            "utf8",
        );
        const second = await runLauncher({
            fixture,
            args: ["update"],
            env: baseEnv,
        });
        assert.equal(second.status, 0);
        assert.ok(hasLine(second.stdout, "launcher already current"));
        assert.ok(
            !second.log.some((line) => line.startsWith("pull")),
            "the image is already present on the second run",
        );
        assert.equal(
            await readFile(join(fixture.repo, ".defined.json"), "utf8"),
            before,
        );
    });
});

test("update refuses to pin a revision whose image is not published", async () => {
    await withFixture("olddeadbeef0", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["update", PIN],
            env: {
                FAKE_GIT_REMOTE: "origin",
                FAKE_GIT_REMOTE_URL: "https://github.com/me/app.git",
                FAKE_INSPECT_FAIL: "1",
                FAKE_MANIFEST_FAIL: "1",
                FAKE_MANIFEST_ERROR: "manifest unknown",
                DEFINED_BIN_DIR: fixture.install,
            },
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /no published image/u);
        const config = JSON.parse(
            await readFile(join(fixture.repo, ".defined.json"), "utf8"),
        );
        assert.equal(
            config.version,
            "olddeadbeef0",
            "the pin must not be written when the image is missing",
        );
        assert.ok(!r.log.some((line) => line.startsWith("pull")));
    });
});

test("update fails when the registry cannot confirm the image", async () => {
    await withFixture("olddeadbeef0", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["update", PIN],
            env: {
                FAKE_GIT_REMOTE: "origin",
                FAKE_GIT_REMOTE_URL: "https://github.com/me/app.git",
                FAKE_INSPECT_FAIL: "1",
                FAKE_MANIFEST_FAIL: "1",
                FAKE_MANIFEST_ERROR: "dial tcp: connection refused",
                DEFINED_BIN_DIR: fixture.install,
            },
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /cannot confirm/u);
    });
});

test("update skips the registry when the image is already present locally", async () => {
    await withFixture("olddeadbeef0", async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["update", PIN],
            env: {
                FAKE_GIT_REMOTE: "origin",
                FAKE_GIT_REMOTE_URL: "https://github.com/me/app.git",
                FAKE_DIGEST: "sha256:aa11bb22cc33dd44",
                FAKE_MANIFEST_FAIL: "1",
                FAKE_MANIFEST_ERROR: "manifest unknown",
                DEFINED_BIN_DIR: fixture.install,
            },
        });
        assert.equal(r.status, 0);
        assert.ok(
            !r.log.some((line) => line.startsWith("manifest")),
            "a locally present image needs no registry lookup",
        );
    });
});

test("update refuses the defined source repository", async () => {
    await withFixture(PIN, async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["update"],
            env: {
                FAKE_REMOTE_REV: REMOTE_REV,
                // The source repo names its remote `defined`, not `origin` —
                // the guard must scan every remote to catch this.
                FAKE_GIT_REMOTE: "defined",
                FAKE_GIT_REMOTE_URL: "git@github.com:markstanden/defined.git",
            },
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /source repo/u);
        assert.ok(!r.log.some((line) => line.startsWith("pull")));
    });
});

test("update fails loudly offline", async () => {
    await withFixture(PIN, async (fixture) => {
        const r = await runLauncher({
            fixture,
            args: ["update"],
            env: { DEFINED_OFFLINE: "1", FAKE_REMOTE_REV: REMOTE_REV },
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /needs the network/u);
    });
});

test("update rejects a malformed or too-short revision", async () => {
    await withFixture(PIN, async (fixture) => {
        const env = {
            FAKE_GIT_REMOTE: "origin",
            FAKE_GIT_REMOTE_URL: "https://github.com/me/app.git",
        };
        const malformed = await runLauncher({
            fixture,
            args: ["update", "not-a-sha"],
            env,
        });
        assert.equal(malformed.status, 1);
        assert.match(malformed.stderr, /invalid revision/u);

        const tooShort = await runLauncher({
            fixture,
            args: ["update", "abc1234"],
            env,
        });
        assert.equal(tooShort.status, 1);
        assert.match(tooShort.stderr, /too short/u);
    });
});
