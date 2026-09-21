// Tests for cli/install.sh: the launcher's verified install path.
//
// The installer is bash; tests drive it with fixture copies of the real
// cli/defined + cli/install.sh and fake git/curl on PATH (the same injection
// style as cli/defined.test.mts). Everything is hermetic: a fake git decides
// whether a checkout is detected, so the tests behave identically in the repo
// and in the gate's scratch workspace.
// Run: node --test cli/install.test.mts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmod,
    cp,
    mkdtemp,
    mkdir,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const CLI_DIR = import.meta.dirname;
const LAUNCHER = resolve(CLI_DIR, "defined");
const INSTALL_SH = resolve(CLI_DIR, "install.sh");
const BASH = "/usr/bin/bash";

/** A full 40-char SHA whose first seven characters are 3f9c1a2. */
const REV = "3f9c1a2" + "0".repeat(33);
const REV_SHORT = "3f9c1a2";
/** A second revision, used to prove the ls-remote resolution path. */
const REV_LATEST = "9f8e7d6" + "1".repeat(33);

interface Fixture {
    root: string;
    home: string;
    bin: string;
    checkout: string;
    standalone: string;
    remote: string;
}

interface InstallRun {
    status: number;
    stdout: string;
    stderr: string;
}

/**
 * Temp dir holding an isolated HOME, an empty install bin, a fake checkout
 * (cli/defined + cli/install.sh), a standalone copy of the installer with no
 * sibling launcher, and a remote dir the fake curl serves from.
 */
async function makeFixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "defined-install-"));
    const home = join(root, "home");
    const bin = join(root, "bin");
    const checkout = join(root, "checkout");
    const standalone = join(root, "standalone");
    const remote = join(root, "remote");
    await mkdir(home);
    await mkdir(bin);
    await mkdir(join(checkout, "cli"), { recursive: true });
    await mkdir(standalone);
    await mkdir(remote);
    for (const file of ["defined", "install.sh"]) {
        await cp(join(CLI_DIR, file), join(checkout, "cli", file));
    }
    await writeFile(join(standalone, "install.sh"), await readFile(INSTALL_SH));
    return { root, home, bin, checkout, standalone, remote };
}

async function withFixture<T>(fn: (f: Fixture) => Promise<T>): Promise<T> {
    const fixture = await makeFixture();
    try {
        return await fn(fixture);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
}

async function writeExecutable(path: string, script: string): Promise<void> {
    await writeFile(path, script);
    await chmod(path, 0o755);
}

/**
 * Fake git driven by env at invocation time. `rev-parse --show-toplevel`
 * answers FAKE_GIT_TOPLEVEL (empty → not a checkout); `rev-parse HEAD` answers
 * FAKE_GIT_HEAD; `ls-remote` answers FAKE_GIT_REMOTE.
 */
async function fakeGit(bin: string): Promise<void> {
    await writeExecutable(
        join(bin, "git"),
        `#!/usr/bin/env bash
case "$*" in
    *"rev-parse --show-toplevel"*)
        if [[ -n "\${FAKE_GIT_TOPLEVEL:-}" ]]; then
            echo "\${FAKE_GIT_TOPLEVEL}"
            exit 0
        fi
        exit 1
        ;;
    *"rev-parse HEAD"*)
        if [[ -n "\${FAKE_GIT_HEAD:-}" ]]; then
            echo "\${FAKE_GIT_HEAD}"
            exit 0
        fi
        exit 1
        ;;
    *"ls-remote"*)
        if [[ -n "\${FAKE_GIT_REMOTE:-}" ]]; then
            printf '%s\\trefs/heads/main\\n' "\${FAKE_GIT_REMOTE}"
            exit 0
        fi
        exit 1
        ;;
    *) exit 1 ;;
esac
`,
    );
}

/** Fake curl: `curl -fsSL -o <dest> <url>` copies FAKE_REMOTE_LAUNCHER. */
async function fakeCurl(bin: string): Promise<void> {
    await writeExecutable(
        join(bin, "curl"),
        `#!/usr/bin/env bash
dest=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o)
            dest="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done
if [[ -z "\${dest}" || -z "\${FAKE_REMOTE_LAUNCHER:-}" ]]; then
    exit 1
fi
cp "\${FAKE_REMOTE_LAUNCHER}" "\${dest}"
`,
    );
}

/** Symlink the coreutils the installer needs on a bare PATH. */
async function symlinkTools(bin: string): Promise<void> {
    for (const tool of ["basename", "dirname", "mktemp", "readlink", "rm"]) {
        await symlink(`/usr/bin/${tool}`, join(bin, tool));
    }
}

/** Run an installer copy, isolated from the host by HOME and PATH. */
async function runInstall({
    fixture,
    script,
    args,
    env = {},
    bare = false,
}: {
    fixture: Fixture;
    script: string;
    args: string[];
    env?: Record<string, string>;
    bare?: boolean;
}): Promise<InstallRun> {
    const path = bare
        ? fixture.bin
        : [fixture.bin, process.env.PATH ?? ""].join(":");
    const result = spawnSync(BASH, [script, ...args], {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
            HOME: fixture.home,
            PATH: path,
            ...env,
        },
    });
    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

const checkoutScript = (fixture: Fixture): string =>
    join(fixture.checkout, "cli", "install.sh");
const standaloneScript = (fixture: Fixture): string =>
    join(fixture.standalone, "install.sh");
const installedPath = (fixture: Fixture): string =>
    join(fixture.bin, "defined");

test("installs the launcher and bakes the revision", async () => {
    await withFixture(async (fixture) => {
        await fakeGit(fixture.bin);
        const r = await runInstall({
            fixture,
            script: checkoutScript(fixture),
            args: ["--rev", REV],
            env: {
                DEFINED_BIN_DIR: fixture.bin,
                FAKE_GIT_TOPLEVEL: fixture.checkout,
            },
        });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /installed launcher/u);
        assert.match(r.stdout, new RegExp(`rev ${REV_SHORT}`, "u"));

        const target = installedPath(fixture);
        const content = await readFile(target, "utf8");
        assert.ok(
            content.includes(`LAUNCHER_REV="${REV}"`),
            "the revision is baked into the installed copy",
        );
        assert.equal((await stat(target)).mode & 0o777, 0o755);

        const version = spawnSync(target, ["--version"], { encoding: "utf8" });
        assert.equal(version.status, 0);
        assert.equal(version.stdout, `defined ${REV_SHORT}\n`);
    });
});

test("re-running with the same revision is a no-op", async () => {
    await withFixture(async (fixture) => {
        await fakeGit(fixture.bin);
        const env = {
            DEFINED_BIN_DIR: fixture.bin,
            FAKE_GIT_TOPLEVEL: fixture.checkout,
        };
        const args = ["--rev", REV];
        const first = await runInstall({
            fixture,
            script: checkoutScript(fixture),
            args,
            env,
        });
        assert.equal(first.status, 0, first.stderr);
        const target = installedPath(fixture);
        const before = await readFile(target, "utf8");

        const second = await runInstall({
            fixture,
            script: checkoutScript(fixture),
            args,
            env,
        });
        assert.equal(second.status, 0, second.stderr);
        assert.match(second.stdout, /already current/u);
        assert.equal(await readFile(target, "utf8"), before);
    });
});

test("refuses a launcher that does not match the installer checksum", async () => {
    await withFixture(async (fixture) => {
        await fakeGit(fixture.bin);
        const tampered = join(fixture.checkout, "cli", "defined");
        await writeFile(
            tampered,
            `${await readFile(LAUNCHER, "utf8")}\n# tampered\n`,
        );
        const r = await runInstall({
            fixture,
            script: checkoutScript(fixture),
            args: ["--rev", REV],
            env: {
                DEFINED_BIN_DIR: fixture.bin,
                FAKE_GIT_TOPLEVEL: fixture.checkout,
            },
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /checksum mismatch/u);
        await assert.rejects(stat(installedPath(fixture)));
    });
});

test("downloads the launcher at the latest resolved revision", async () => {
    await withFixture(async (fixture) => {
        await fakeGit(fixture.bin);
        await fakeCurl(fixture.bin);
        const served = join(fixture.remote, "defined");
        await writeFile(served, await readFile(LAUNCHER, "utf8"));
        const r = await runInstall({
            fixture,
            script: standaloneScript(fixture),
            args: [],
            env: {
                DEFINED_BIN_DIR: fixture.bin,
                FAKE_GIT_REMOTE: REV_LATEST,
                FAKE_REMOTE_LAUNCHER: served,
            },
        });
        assert.equal(r.status, 0, r.stderr);
        const content = await readFile(installedPath(fixture), "utf8");
        assert.ok(content.includes(`LAUNCHER_REV="${REV_LATEST}"`));
    });
});

test("fails loudly when no downloader is available", async () => {
    await withFixture(async (fixture) => {
        await fakeGit(fixture.bin);
        await symlinkTools(fixture.bin);
        const r = await runInstall({
            fixture,
            script: standaloneScript(fixture),
            args: ["--rev", REV],
            env: { DEFINED_BIN_DIR: fixture.bin },
            bare: true,
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /neither curl nor wget/u);
    });
});

test("rejects a malformed revision", async () => {
    await withFixture(async (fixture) => {
        await fakeGit(fixture.bin);
        const r = await runInstall({
            fixture,
            script: checkoutScript(fixture),
            args: ["--rev", "not-a-sha"],
            env: {
                DEFINED_BIN_DIR: fixture.bin,
                FAKE_GIT_TOPLEVEL: fixture.checkout,
            },
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /invalid revision/u);
    });
});

test("the embedded checksum matches cli/defined", async () => {
    const expected = createHash("sha256")
        .update(await readFile(LAUNCHER))
        .digest("hex");
    const script = await readFile(INSTALL_SH, "utf8");
    const match = /^LAUNCHER_SHA256="([0-9a-f]{64})"$/mu.exec(script);
    assert.ok(match, "install.sh must declare LAUNCHER_SHA256");
    assert.equal(
        match[1],
        expected,
        "cli/defined changed: update LAUNCHER_SHA256 in cli/install.sh",
    );
});
