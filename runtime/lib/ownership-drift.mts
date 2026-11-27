// runtime/lib/ownership-drift.mts — advisory ownership-drift notices.
//
// Two sources, one channel: a consumer `.defined.json` override that weakens
// the house floor, and a project-owned seeded default that differs from the
// image-baked copy. Both are advisory — the report renders them as `notices`,
// and neither the gate's status nor its exit code ever changes because of
// them. Managed files are excluded: their drift is a failure the bootstrap
// check already owns.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readContentsOrEmpty } from "./agents-block.mts";
import type { DefinedConfig } from "./config.mts";
import type { ManagedFile } from "./managed-files.mts";

/** The house default line-coverage minimum; a consumer may tighten, not lower. */
export const HOUSE_COVERAGE_LINE_MINIMUM = 80;

/** One advisory ownership-drift notice. */
export interface DriftNotice {
    /**
     * Consumer config weakening (`config`), an edited seeded default
     * (`seeded`) or the steps a `scan --files` run left whole (`selection`).
     */
    kind: "config" | "seeded" | "selection";
    /** Single-line, single-phrase description of the drift. */
    message: string;
    /** Repo-relative file that owns the drift, when one does. */
    file?: string;
}

const CONFIG_FILE = ".defined.json";

/** A config weakening notice, prefixed with the key that carries it. */
function configNotice(where: string, message: string): DriftNotice {
    return {
        kind: "config",
        file: CONFIG_FILE,
        message: `${where}: ${message}`,
    };
}

const DISABLE_SWITCHES = [
    {
        key: "eslint.disable",
        on: (config: DefinedConfig) => config.eslint?.disable === true,
        message: "disables the house ESLint floor",
    },
    {
        key: "dotnet.disable",
        on: (config: DefinedConfig) => config.dotnet?.disable === true,
        message: "disables the house .NET steps",
    },
    {
        key: "workflow.disable",
        on: (config: DefinedConfig) => config.workflow?.disable === true,
        message: "stops the managed gate workflow",
    },
] as const;

/** Consumer overrides that switch off or lower a house check. */
export function configDrift(config: DefinedConfig): DriftNotice[] {
    const notices = DISABLE_SWITCHES.filter((switchConfig) =>
        switchConfig.on(config),
    ).map((switchConfig) =>
        configNotice(switchConfig.key, switchConfig.message),
    );
    // A scope is a legitimate narrowing, not a disabled check: it never widens
    // what passes, but it does shrink what is judged, so it must be visible on
    // every verb — including `scan`, which never adopts and so runs no bootstrap
    // check to hang the notice on.
    const scope = config.scope?.include;
    if (scope !== undefined) {
        notices.push(
            configNotice(
                "scope.include",
                `narrows the content checks to ${scope.length} selector(s)`,
            ),
        );
    }
    for (const ecosystem of ["node", "dotnet"] as const) {
        const line = config.coverage?.[ecosystem]?.minimums?.line;
        if (line !== undefined && line < HOUSE_COVERAGE_LINE_MINIMUM) {
            notices.push(
                configNotice(
                    `coverage.${ecosystem}.minimums.line`,
                    `${line} is below the house minimum ${HOUSE_COVERAGE_LINE_MINIMUM}`,
                ),
            );
        }
    }
    return notices;
}

/**
 * The cosmetic channels a seeded default can differ by without changing a
 * setting: comments (`#`, `;`, `<!--`), blank lines (including a missing or
 * extra final newline), trailing whitespace and CRLF line endings. A repo may
 * reword a comment or let an editor touch the file; neither is drift.
 *
 * ponytail: line-oriented, not a per-format settings parser. A reordered or
 * re-wrapped line still reports, which is the conservative direction — a real
 * setting change is never silenced. Upgrade path: parse settings per format
 * (editorconfig, gitattributes, MSBuild props) if reordering ever becomes
 * noisy.
 */
function withoutCosmetics(text: string): string {
    return text
        .replaceAll("\r\n", "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line !== "" && !/^\s*(?:#|;|<!--)/u.test(line))
        .join("\n");
}

/**
 * Seeded defaults the repo has replaced with its own copy. Absence is the
 * repo's choice, not drift, and a managed file is excluded — the bootstrap
 * check owns that verdict. A cosmetic-only difference is not a replacement:
 * the file still carries the house settings.
 */
async function seededDrift({
    sourceDir,
    files,
    repoRoot,
}: {
    sourceDir: string;
    files: ManagedFile[];
    repoRoot: string;
}): Promise<DriftNotice[]> {
    const seeded = files.filter(({ mode }) => mode === "seeded");
    const rows = await Promise.all(
        seeded.map(async ({ source, target }): Promise<DriftNotice | null> => {
            const desired = await readFile(join(sourceDir, source), "utf8");
            const existing = await readContentsOrEmpty({
                filePath: join(repoRoot, target),
            });
            if (
                existing === "" ||
                withoutCosmetics(existing) === withoutCosmetics(desired)
            ) {
                return null;
            }
            return {
                kind: "seeded",
                file: target,
                message:
                    "repo copy differs from the house default (project-owned)",
            };
        }),
    );
    return rows.filter((row): row is DriftNotice => row !== null);
}

/**
 * The advisory ownership-drift set for a repo: weakened `.defined.json`
 * overrides first, then seeded defaults the repo has replaced.
 */
export async function ownershipDrift({
    config,
    sourceDir,
    files,
    repoRoot,
}: {
    config: DefinedConfig;
    /** The baked standards directory holding the seeded copies. */
    sourceDir: string;
    /** The bootstrap set, so our caller's mode filtering is the single owner. */
    files: ManagedFile[];
    repoRoot: string;
}): Promise<DriftNotice[]> {
    return [
        ...configDrift(config),
        ...(await seededDrift({ sourceDir, files, repoRoot })),
    ];
}
