// Tests for the Containerfile's download hardening: every upstream release
// asset is fetched to a file, verified against its pinned sha256, and only
// then unpacked into PATH. The pins live in tool-versions.env, so these tests
// prove the two files agree and that no unverified download or build-time
// "latest" lookup can slip in.
//
// Scope: the GitHub release downloads (the tool pins). The Microsoft apt
// bootstrap deb is out of scope — it is a rolling asset, and apt verifies the
// packages it enables by signature rather than by hash.
// Run: node --test runtime/containerfile.test.mts

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const RUNTIME_DIR = import.meta.dirname;

interface Download {
    /** The file the asset is written to (`curl -o <path>`). */
    path: string;
    /** Tool prefix from the URL's `${<PREFIX>_VERSION}` reference. */
    tool: string;
}

async function readContainerfile(): Promise<string> {
    return readFile(join(RUNTIME_DIR, "Containerfile"), "utf8");
}

async function readPins(): Promise<Map<string, string>> {
    const text = await readFile(
        join(RUNTIME_DIR, "tool-versions.env"),
        "utf8",
    );
    const pins = new Map<string, string>();
    for (const match of text.matchAll(/^(\w+)="([^"]*)"$/gmu)) {
        pins.set(match[1]!, match[2]!);
    }
    return pins;
}

/** Every GitHub release download in the Containerfile. */
function downloads({ text }: { text: string }): Download[] {
    const found: Download[] = [];
    const pattern =
        /-o\s+(\/tmp\/\S+)\s+"https:\/\/github\.com\/[^"]*\$\{(\w+)_VERSION\}/gu;
    for (const match of text.matchAll(pattern)) {
        found.push({ path: match[1]!, tool: match[2]! });
    }
    return found;
}

test("the Containerfile downloads the expected gate tools", async () => {
    // Arrange
    const text = await readContainerfile();

    // Act
    const found = downloads({ text }).map((entry) => entry.tool);

    // Assert
    assert.deepEqual(found.sort(), [
        "ACTIONLINT",
        "GITLEAKS",
        "OPENTOFU",
        "SHELLCHECK",
        "SHFMT",
        "TFLINT",
        "ZIZMOR",
    ]);
});

// Parameterised per download, so a failure names the tool that skipped its
// check. The Containerfile is parsed once, at load.
const DOWNLOADS = downloads({ text: await readContainerfile() });

for (const download of DOWNLOADS) {
    test(`verifies the ${download.tool} download before unpacking it`, async () => {
        // Arrange
        const text = await readContainerfile();
        const verified = text.includes(
            `verify "\${${download.tool}_SHA256}" ${download.path}`,
        );
        const aliased = ["AMD64", "ARM64"].every((arch) =>
            text.includes(
                `${download.tool}_SHA256="\${${download.tool}_SHA256_${arch}}"`,
            ),
        );

        // Assert
        assert.ok(
            verified,
            `${download.path} is not checked against ${download.tool}_SHA256`,
        );
        assert.ok(
            aliased,
            `${download.tool}_SHA256 is not selected for both architectures`,
        );
        // A pipe would put unverified bytes straight into the install path.
        assert.ok(
            !text.includes(`| tar -xz`),
            "downloads must be verified to a file, never piped into tar",
        );
    });
}

test("every downloaded tool pins both architectures' sha256", async () => {
    // Arrange
    const text = await readContainerfile();
    const pins = await readPins();

    // Act
    const tools = DOWNLOADS.map((entry) => entry.tool);

    // Assert
    for (const tool of tools) {
        assert.match(
            pins.get(`${tool}_VERSION`) ?? "",
            /^\d+\.\d+\.\d+$/u,
            `${tool}_VERSION must be a pinned release, never a moving ref`,
        );
        for (const arch of ["AMD64", "ARM64"]) {
            assert.match(
                pins.get(`${tool}_SHA256_${arch}`) ?? "",
                /^[0-9a-f]{64}$/u,
                `${tool}_SHA256_${arch} must be a pinned sha256`,
            );
        }
    }
});

test("the build resolves no release through the GitHub API", async () => {
    // Arrange
    const text = await readContainerfile();

    // Act
    const apiLookup = /api\.github\.com|releases\/latest/u.test(text);

    // Assert
    assert.ok(!apiLookup, "pin versions in tool-versions.env instead");
});
