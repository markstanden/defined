#!/usr/bin/env node
// setup.mts — gate bootstrap (decisions #13–14).
//
// runSetup is the write path, invoked as the first phase of `comply`; it
// installs shared files from standards/ into the repo, seeds the AGENTS.md
// managed block from config/agents-block.md, and creates a pinned
// .defined.json when the repo has none. Idempotent: re-runs rewrite the block
// only, leave unchanged files alone, and never touch an existing
// .defined.json. Seeded defaults are installed only when absent (the repo's
// own copy always wins); managed files are brought back to the gate copy so a
// gate update propagates. checkSetup is the read-only path used by `verify`;
// it reports gate-owned bootstrap state (seeded defaults are not gated)
// without writing a byte.
//
// Pure module: no top-level main — comply.mts owns the entry point, so this
// file is never double-executed when imported.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    checkMarkedBlock,
    readMarkedBlock,
    writeMarkedBlock,
    type MarkedBlockStatus,
} from "./lib/agents-block.mts";
import {
    checkManagedFiles,
    installManagedFiles,
    type CheckedFile,
    type ManagedFile,
} from "./lib/managed-files.mts";
import { gateConfigPath, standardsDir } from "./lib/config-path.mts";
import { deriveRepoRoot } from "../lib/paths.mts";

// Shared files for every consumer repo, in two tiers. standards/ is the single
// source of truth (decision #19): each file lives there and is installed from
// it — no copied config/root/ that can drift. Sources are relative to
// standards/, targets to the repo root; they differ where standards/ does not
// mirror the repo layout (the gate workflow).
//
// - seeded: house defaults (.editorconfig, Directory.Build.props,
//   .gitattributes). Installed only when absent — a repo with its own rules
//   keeps them, and `verify` never gates on them. `.gitattributes` carries the
//   same LF/whitespace contract as .editorconfig's end_of_line.
// - managed: gate-owned plumbing (.github/workflows/defined--verify.yml).
//   Byte-identical to the image: `comply` overwrites a differing copy so a
//   gate update propagates, and `verify` fails on drift. It carries no gate
//   version, so the pin lives only in .defined.json (decision #36).
const BOOTSTRAP_FILES: ManagedFile[] = [
    { source: ".editorconfig", target: ".editorconfig", mode: "seeded" },
    {
        source: "Directory.Build.props",
        target: "Directory.Build.props",
        mode: "seeded",
    },
    { source: ".gitattributes", target: ".gitattributes", mode: "seeded" },
    {
        source: "workflows/defined--verify.yml",
        target: ".github/workflows/defined--verify.yml",
        mode: "managed",
    },
];

const CONFIG_FILE = ".defined.json";

// tool-versions.env lives next to setup.mts — /opt/defined/runtime baked in
// the image, runtime/ on a host checkout. Same bytes either way, so the
// pinhash always matches what comply.sh and the publish workflow tag.
const TOOL_VERSIONS_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "tool-versions.env",
);

/**
 * The immutable image tag for the image that actually ran: the 12-char hash
 * of tool-versions.env (pinhash), the same tag comply.sh builds locally and
 * the publish workflow pushes to ghcr.
 */
async function imagePin(): Promise<string> {
    const content = await readFile(TOOL_VERSIONS_PATH, "utf8");
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/**
 * Seed a pinned .defined.json when the repo has none — the omitted-version
 * default self-improves to an immutable pin on first `comply`. An existing
 * file (explicit pin, coverage config) is never touched.
 */
async function ensureConfigFile(repoRoot: string): Promise<void> {
    const configPath = join(repoRoot, CONFIG_FILE);
    if (existsSync(configPath)) {
        return;
    }
    await writeFile(
        configPath,
        `${JSON.stringify({ version: await imagePin() })}\n`,
    );
}

/**
 * Bootstrap a target repo (startDir's git root): install seeded defaults and
 * managed files, upsert the AGENTS.md managed block, and seed a pinned
 * .defined.json when absent. Order matters — the block references the installed
 * files, so it reflects reality by the time it is written. Prints nothing:
 * `comply` renders output via the report contract.
 */
export async function runSetup({
    startDir,
}: {
    startDir: string;
}): Promise<void> {
    const repoRoot = await deriveRepoRoot({ startDir });
    await installManagedFiles({
        sourceDir: await standardsDir(),
        files: BOOTSTRAP_FILES,
        repoRoot,
    });
    await ensureConfigFile(repoRoot);

    const block = await readMarkedBlock({
        templatePath: await gateConfigPath({ name: "agents-block.md" }),
    });
    await writeMarkedBlock({ filePath: join(repoRoot, "AGENTS.md"), block });
}

export interface SetupCheck {
    files: CheckedFile[];
    agents: MarkedBlockStatus;
}

/**
 * Read-only bootstrap state for `verify`: report every gate-owned artifact
 * (the managed workflow + AGENTS.md block) without writing a byte. Seeded
 * defaults are deliberately absent from the verdict — the repo's own copy is
 * its business. `comply` installs and repairs these; `verify` must detect
 * absence/drift/corruption and fail loudly so local green always implies a
 * fully bootstrapped checkout.
 */
export async function checkSetup({
    startDir,
}: {
    startDir: string;
}): Promise<SetupCheck> {
    const repoRoot = await deriveRepoRoot({ startDir });
    const files = await checkManagedFiles({
        sourceDir: await standardsDir(),
        files: BOOTSTRAP_FILES,
        repoRoot,
    });
    const block = await readMarkedBlock({
        templatePath: await gateConfigPath({ name: "agents-block.md" }),
    });
    const agents = await checkMarkedBlock({
        filePath: join(repoRoot, "AGENTS.md"),
        block,
    });
    return { files, agents };
}
