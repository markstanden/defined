// steps/node.mts — Node/JS projects: repo-wide formatting via prettier.
//
// Tools:    prettier
// Config:   runtime/config/prettier.config.mjs (pure defaults) + prettierignore,
//           passed explicitly (--config/--ignore-path) so they travel with the
//           gate. Indentation comes from the project's .editorconfig, which
//           prettier reads natively and gives higher priority than --config
//           (verified 2026-08-30) — so gate setup installing .editorconfig
//           makes prettier, shfmt and IDEs agree from one source.
//           NOTE (2026-08-30): prettier resolves ignore patterns relative to
//           the ignore FILE, not CWD (getRelativePath(file, ignoreFile)) — a
//           travelling/temp ignore must live at the repo root for
//           repo-relative directory patterns to match. See PLAN.md "Confirmed:
//           prettier resolves ignore patterns…".
// Fix:      prettier --write rewrites, then the step re-checks before
//           reporting — a fix that leaves diffs can never read as success
//
// Scope is git's (decision: "gate scope = git scope"). Prettier runs over the
// gate's tracked list (git ls-files -co --exclude-standard — tracked plus
// untracked-but-not-ignored) filtered to the extensions prettier can parse,
// NOT over the whole CWD tree: prettier does not honour .gitignore, so a
// whole-tree walk would format gitignored build dirs (bin/obj/dist) and make
// local vs CI disagree. Build dirs are gitignored, so they are absent from
// the tracked list by construction. The travelling ignore still excludes
// committed-but-not-for-prettier files (lockfiles, toml, properties) and a
// consumer's own .prettierignore stays additive for the rare committed-but-
// exempt case.
//
// Detection is sync and data-driven: activation = at least one tracked
// package.json (any depth) OR a tracked *.md file. Prettier is repo-wide
// (markdown, JSON/JSONC, YAML, CSS) regardless of Node, so a docs-only repo
// still gets markdown formatting — the house prettier config claims repo-wide
// scope and the step must honour it. ESLint/tsc/vitest deliberately wait for
// in-container dependency restore (decision #3): they need project-local
// plugins and types a global install cannot supply.
// The runner is injected so tests need no host binaries.

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
    failed,
    passed,
    skipped,
    type StepResult,
} from "../lib/step-result.mts";
import { run } from "../../lib/proc.mts";
import { gateConfigPath } from "../lib/config-path.mts";

export interface NodeRunContext {
    mode: "fix" | "no-fix";
    repoRoot: string;
}

type Runner = typeof run;

export function filterPackageJsons({ files }: { files: string[] }): string[] {
    return files.filter((file) => file.split("/").pop() === "package.json");
}

export function filterMarkdownFiles({ files }: { files: string[] }): string[] {
    return files.filter((file) => file.endsWith(".md"));
}

/**
 * File extensions prettier can parse with pure defaults (no plugins) —
 * verified 2026-09-06 against prettier 3.9.6 in the gate image. Files outside
 * this set are never handed to prettier as explicit paths: prettier errors
 * on an explicitly-listed file it cannot parse ("No parser could be
 * inferred"), whereas a whole-tree walk silently skips it.
 */
export const PRETTIER_EXTENSIONS = [
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "mts",
    "cts",
    "tsx",
    "json",
    "jsonc",
    "json5",
    "yml",
    "yaml",
    "md",
    "markdown",
    "mdx",
    "css",
    "scss",
    "less",
    "html",
    "htm",
    "vue",
    "graphql",
    "gql",
    "hbs",
    "handlebars",
] as const;

/**
 * Keep only the tracked files prettier can parse. The input is already
 * git-scoped (tracked + untracked-but-not-ignored), so gitignored build dirs
 * never reach prettier and no per-tool build-dir ignore is needed.
 */
export function filterPrettierFiles({ files }: { files: string[] }): string[] {
    return files.filter((file) => {
        const dot = file.lastIndexOf(".");
        if (dot === -1) {
            return false;
        }
        const ext = file.slice(dot + 1);
        return (PRETTIER_EXTENSIONS as readonly string[]).includes(ext);
    });
}

/**
 * Effective prettier ignore args. The gate's travelling ignore is the base
 * (generic patterns like coverage/ and *.toml match from any location); the
 * host repo's own `.prettierignore` (if present) is additive and resolves
 * correctly because it sits at the repo root. prettier combines repeated
 * --ignore-path flags (its ignorePath is an array), and resolves each file's
 * patterns relative to that file's own location (getRelativePath) — so a
 * merged temp file would silently no-op repo-relative directory patterns.
 * See PLAN.md "Confirmed: prettier resolves ignore patterns…".
 */
export async function prettierIgnoreArgs({
    repoRoot,
}: {
    repoRoot: string;
}): Promise<string[]> {
    const basePath = await gateConfigPath({ name: "prettierignore" });
    const args = ["--ignore-path", basePath];
    if (existsSync(join(repoRoot, ".prettierignore"))) {
        args.push("--ignore-path", join(repoRoot, ".prettierignore"));
    }
    return args;
}

/**
 * Run prettier over the git-scoped tracked files prettier can parse when the
 * project is a Node project or has markdown. Returns skip with a notice when
 * neither exists, or when no tracked file is prettier-parseable; fail naming
 * the unformatted-file count otherwise.
 */
export async function runNodeStep({
    ctx,
    trackedFiles,
    runner = run,
}: {
    ctx: NodeRunContext;
    trackedFiles: string[];
    runner?: Runner;
}): Promise<StepResult> {
    const manifests = filterPackageJsons({ files: trackedFiles });
    const markdownFiles = filterMarkdownFiles({ files: trackedFiles });
    if (manifests.length === 0 && markdownFiles.length === 0) {
        return skipped({
            notice: "node: no tracked package.json or *.md files",
        });
    }

    // Gate scope = git scope: format exactly the tracked files prettier can
    // parse (see module header). Gitignored build dirs never appear here.
    const prettierFiles = filterPrettierFiles({ files: trackedFiles });
    if (prettierFiles.length === 0) {
        return skipped({
            notice: "node: no tracked files prettier can parse",
        });
    }

    const config = await gateConfigPath({ name: "prettier.config.mjs" });
    const sharedArgs = [
        "--config",
        config,
        ...(await prettierIgnoreArgs({ repoRoot: ctx.repoRoot })),
    ];

    if (ctx.mode === "fix") {
        const write = runner({
            cmd: "prettier",
            args: ["--write", ...sharedArgs, ...prettierFiles],
            cwd: ctx.repoRoot,
        });
        if (write.status !== 0) {
            return failed({
                notice: `node: prettier --write failed: ${write.stderr.trim()}`,
            });
        }
    }

    // Always verify clean — in fix mode this proves the rewrite left nothing.
    const check = runner({
        cmd: "prettier",
        args: ["--check", ...sharedArgs, ...prettierFiles],
        cwd: ctx.repoRoot,
    });
    if (check.status !== 0) {
        const unformatted = check.stdout
            .split("\n")
            .filter((line) => line.trim() !== "").length;
        return failed({
            notice: `node: prettier found ${unformatted} unformatted file(s)`,
        });
    }

    return passed({
        notice: `node: tree formatted (${manifests.length} package(s), ${markdownFiles.length} md, ${prettierFiles.length} parseable)`,
    });
}
