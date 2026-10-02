// runtime/lib/eslint-example.mts — the house-example sidecar's lifecycle.
//
// The sidecar (`eslint.config.defined.mjs`) is a discoverability artefact the
// ESLint step writes beside a repo-owned config and removes when there is none.
// Bootstrap is the second owner: a repair may have *deleted* the repo's config
// since the sidecar was written, leaving a stale file the house scope must not
// keep (#62). Rather than reach into `.git/info/exclude` from two places, the
// path handling and the prune live here.

import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ESLINT_EXAMPLE_NAME } from "./eslint-config.mts";

function examplePath({ workingRoot }: { workingRoot: string }): string {
    return join(workingRoot, ESLINT_EXAMPLE_NAME);
}

function excludeFilePath({ repoRoot }: { repoRoot: string }): string {
    return join(repoRoot, ".git", "info", "exclude");
}

/**
 * Add the sidecar to `.git/info/exclude`; false when git or the entry is
 * absent, true when a new line was written.
 */
export async function excludeExample({
    repoRoot,
}: {
    repoRoot: string;
}): Promise<boolean> {
    const excludePath = excludeFilePath({ repoRoot });
    if (!existsSync(dirname(excludePath))) {
        return false;
    }
    const current = existsSync(excludePath)
        ? await readFile(excludePath, "utf8")
        : "";
    if (current.split("\n").includes(ESLINT_EXAMPLE_NAME)) {
        return false;
    }
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await writeFile(
        excludePath,
        `${current}${separator}${ESLINT_EXAMPLE_NAME}\n`,
    );
    return true;
}

/** Drop the sidecar's exclusion line from `.git/info/exclude`, if present. */
export async function pruneExampleExclusion({
    repoRoot,
}: {
    repoRoot: string;
}): Promise<void> {
    const excludePath = excludeFilePath({ repoRoot });
    if (!existsSync(excludePath)) {
        return;
    }
    const current = await readFile(excludePath, "utf8");
    const next = current
        .split("\n")
        .filter((line) => line !== ESLINT_EXAMPLE_NAME)
        .join("\n");
    if (next !== current) {
        await writeFile(excludePath, next);
    }
}

/**
 * Remove a now-redundant sidecar (and its exclusion) from a working root: the
 * repo has no config of its own for the example to sit beside. Idempotent — a
 * missing file is a no-op.
 */
export async function removeExample({
    workingRoot,
}: {
    workingRoot: string;
}): Promise<void> {
    const path = examplePath({ workingRoot });
    if (existsSync(path)) {
        await rm(path, { force: true });
    }
    await pruneExampleExclusion({ repoRoot: workingRoot });
}

/** Write the house default to the sidecar path and notice the consumer. */
export async function writeExample({
    workingRoot,
    desired,
    notify,
}: {
    workingRoot: string;
    /** The house config's current bytes (the example's content). */
    desired: string;
    notify: (line: string) => void;
}): Promise<void> {
    const path = examplePath({ workingRoot });
    const current = existsSync(path) ? await readFile(path, "utf8") : "";
    if (current !== desired) {
        await writeFile(path, desired);
    }
    const excluded = await excludeExample({ repoRoot: workingRoot });
    notify(
        `defined: repo eslint config kept; wrote ${ESLINT_EXAMPLE_NAME} (house example)` +
            (excluded ? " and added it to .git/info/exclude" : ""),
    );
}
