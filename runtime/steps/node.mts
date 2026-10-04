// steps/node.mts — Node/JS projects: repo-wide formatting via prettier.
//
// Tools:    prettier
// Config:   runtime/config/prettier.config.mjs (pure defaults) + prettierignore,
//           passed explicitly (--config/--ignore-path) so they travel with the
//           gate. A consumer-owned prettier config at the repo root wins when
//           present (see prettierConfigArgs). Indentation comes from the
//           project's .editorconfig, which prettier reads natively and gives
//           higher priority than --config (verified 2026-08-30) — so gate setup
//           installing .editorconfig makes prettier, shfmt and IDEs agree from
//           one source, and a consumer config cannot break the indent invariant.
//           NOTE (2026-08-30): prettier resolves ignore patterns relative to
//           the ignore FILE, not CWD (getRelativePath(file, ignoreFile)) — a
//           travelling/temp ignore must live at the repo root for
//           repo-relative directory patterns to match.
// Fix:      prettier --write only. This is the repair pass (#65): check-only
//           work runs once, in the authoritative no-fix verification pass — a
//           fix that leaves diffs is caught there, never read as success here.
//           (A read-only verify cannot write, so it checks the scratch copy.)
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
// scope and the step must honour it. ESLint/tsc/vitest are not here: they run
// in the dedicated `node-checks` step, against the dependencies `node-deps`
// restored (issue #19/#21/#40).
//
// Working root: prettier runs in the same directory the node family restores
// and checks in — the repo for fix, the shared /tmp scratch copy for no-fix —
// so a consumer config that declares plugins resolves them from the restored
// dependencies on a fresh checkout (issue #40). The runner is injected so tests
// need no host binaries.

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
    errored,
    failed,
    passed,
    skipped,
    type StepDiagnostic,
    type StepResult,
} from "../lib/step-result.mts";
import { resolveWorkingRoot, type Scratch } from "../lib/scratch.mts";
import { run, failureDetail } from "../../lib/proc.mts";
import { gateConfigPath, toolVersionsPath } from "../lib/config-path.mts";
import { filterPackageJsons } from "../lib/node-packages.mts";
import {
    CONSUMER_PRETTIER_CONFIGS,
    hasConsumerPrettierConfig,
} from "../lib/prettier-config.mts";
import {
    createFileCache,
    hashFile,
    identityHash,
    partitionByHash,
    reportCacheMetric,
    type FileCache,
} from "../lib/cache.mts";

export interface NodeRunContext {
    /** Repair (fix) or authoritative verification (no-fix) — see comply #65. */
    mode: "fix" | "no-fix";
    /** Repo root the checkout was mounted at; scratch copies hang off it. */
    repoRoot: string;
    /** Shared scratch box (no-fix): the same copy node-deps restored into. */
    scratch?: Scratch;
    /** Content-cache root (#68); caching is off when absent. */
    cacheDir?: string;
    /** Opt-in metric sink (`--timings`); metrics are silent without it. */
    notify?: (line: string) => void;
}

type Runner = typeof run;

/** Tracked markdown files; the node step formats the `.md` scope with prettier. */
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
 */
export async function prettierIgnoreArgs({
    repoRoot,
}: {
    repoRoot: string;
}): Promise<string[]> {
    const basePath = gateConfigPath({ name: "prettierignore" });
    const args = ["--ignore-path", basePath];
    if (existsSync(join(repoRoot, ".prettierignore"))) {
        args.push("--ignore-path", join(repoRoot, ".prettierignore"));
    }
    return args;
}

/**
 * Effective prettier config args. The gate's own config travels with the image
 * so a repo with no preferences still formats to house defaults; a
 * consumer-owned config at the repo root wins when present, so a project can
 * express its own Prettier preferences without forking the gate. Indentation
 * stays owned by `.editorconfig` (installed by bootstrap): prettier gives
 * `.editorconfig` higher priority than `--config`, so the two cannot disagree.
 *
 * `repoRoot` here is the pass's working root: for no-fix it is the scratch
 * copy, which is where node-deps restored the consumer's plugins, so a
 * config-declared plugin resolves (issue #40).
 */
export async function prettierConfigArgs({
    repoRoot,
}: {
    repoRoot: string;
}): Promise<string[]> {
    for (const name of CONSUMER_PRETTIER_CONFIGS) {
        const candidate = join(repoRoot, name);
        if (existsSync(candidate)) {
            return ["--config", candidate];
        }
    }
    return ["--config", gateConfigPath({ name: "prettier.config.mjs" })];
}

// prettier --check prints `[warn] <file>` per unformatted file, then a summary
// line ("[warn] Code style issues found in N files...") which is not a file.
const PRETTIER_WARN = /^\[warn\] (.+)$/u;

/** Every unformatted file prettier named, as a structured diagnostic. */
export function parsePrettierFindings({
    stdout,
}: {
    stdout: string;
}): StepDiagnostic[] {
    const errors: StepDiagnostic[] = [];
    for (const raw of stdout.split("\n")) {
        const match = PRETTIER_WARN.exec(raw.trim());
        if (match === null) {
            continue;
        }
        const file = match[1]!;
        if (file.startsWith("Code style issues")) {
            continue;
        }
        errors.push({
            kind: "finding",
            file,
            message: "unformatted (run prettier --write)",
        });
    }
    return errors;
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

    // The same working root node-deps restored into: repo for fix, shared
    // scratch copy for no-fix. Prettier's own file paths stay repo-relative
    // (the scratch mirrors the repo layout), but config, ignore file and CWD
    // must point at the working root so consumer plugins resolve.
    const workingRoot = resolveWorkingRoot({
        mode: ctx.mode,
        repoRoot: ctx.repoRoot,
        scratch: ctx.scratch,
        files: trackedFiles,
    });
    const sharedArgs = [
        ...(await prettierConfigArgs({ repoRoot: workingRoot })),
        ...(await prettierIgnoreArgs({ repoRoot: workingRoot })),
    ];

    // Repair (#65): mutate only. prettier --write rewrites the tree; the check
    // belongs to the single authoritative no-fix pass, never here.
    if (ctx.mode === "fix") {
        const write = await runner({
            cmd: "prettier",
            args: ["--write", ...sharedArgs, ...prettierFiles],
            cwd: workingRoot,
        });
        if (write.status !== 0) {
            return errored({
                message: `node: prettier --write failed: ${failureDetail({
                    result: write,
                })}`,
            });
        }
        return passed({
            notice: `node: formatted ${prettierFiles.length} file(s)`,
        });
    }

    // Verification: prettier --check decides, via the content cache where the
    // house config lets per-file reuse (#68).
    return verifyNode({
        ctx,
        prettierFiles,
        sharedArgs,
        workingRoot,
        trackedFiles,
        runner,
        summary: `${manifests.length} package(s), ${markdownFiles.length} md, ${prettierFiles.length} parseable`,
    });
}

/**
 * The authoritative no-fix prettier check. With the house config unchanged
 * files are served from the content cache and only misses reach prettier (#68);
 * the merge is in scope order so cached and uncached verdicts agree. Caching
 * off (a consumer config, or no cache dir) falls back to one whole-scope check.
 */
async function verifyNode({
    ctx,
    prettierFiles,
    sharedArgs,
    workingRoot,
    trackedFiles,
    runner,
    summary,
}: {
    ctx: NodeRunContext;
    prettierFiles: string[];
    sharedArgs: string[];
    workingRoot: string;
    trackedFiles: string[];
    runner: Runner;
    /** Human counts for the notice: "N package(s), M md, K parseable". */
    summary: string;
}): Promise<StepResult> {
    const cache = nodeFileCache({ ctx, trackedFiles, workingRoot });
    if (cache === undefined) {
        return runPrettierCheck({
            files: prettierFiles,
            sharedArgs,
            workingRoot,
            runner,
            summary,
        });
    }

    const { cached, missing, hashes } = partitionByHash<boolean>({
        paths: prettierFiles,
        workingRoot,
        cache,
    });
    const dirty = new Set<string>();
    for (const [file, clean] of cached) {
        if (!clean) {
            dirty.add(file);
        }
    }
    const outcome = await checkPrettier({
        files: missing,
        sharedArgs,
        workingRoot,
        runner,
    });
    if ("error" in outcome) {
        return errored({ message: outcome.error });
    }
    for (const finding of outcome.findings) {
        dirty.add(finding.file ?? "");
    }
    for (const file of missing) {
        const hash = hashes.get(file);
        if (hash !== undefined) {
            cache.record({ path: file, hash }, !dirty.has(file));
        }
    }
    cache.flush();
    reportCacheMetric({ notify: ctx.notify, step: "node", cache });

    const errors = prettierFiles
        .filter((file) => dirty.has(file))
        .map((file) => ({
            kind: "finding" as const,
            file,
            message: "unformatted (run prettier --write)",
        }));
    const counts = `${cache.hits} cached, ${missing.length} checked`;
    if (errors.length > 0) {
        return failed({
            notice: `node: prettier found ${errors.length} unformatted file(s) (${counts})`,
            errors,
        });
    }
    return passed({ notice: `node: tree formatted (${summary}; ${counts})` });
}

/** A whole-scope (uncached) prettier --check and its result. */
async function runPrettierCheck({
    files,
    sharedArgs,
    workingRoot,
    runner,
    summary,
}: {
    files: string[];
    sharedArgs: string[];
    workingRoot: string;
    runner: Runner;
    summary: string;
}): Promise<StepResult> {
    const outcome = await checkPrettier({
        files,
        sharedArgs,
        workingRoot,
        runner,
    });
    if ("error" in outcome) {
        return errored({ message: outcome.error });
    }
    if (outcome.findings.length > 0) {
        return failed({
            notice: `node: prettier found ${outcome.findings.length} unformatted file(s)`,
            errors: outcome.findings,
        });
    }
    return passed({ notice: `node: tree formatted (${summary})` });
}

/**
 * Run prettier --check over `files` and return the parsed per-file findings, or
 * an execution error. An empty list short-circuits: the all-cached run spawns
 * no process.
 */
async function checkPrettier({
    files,
    sharedArgs,
    workingRoot,
    runner,
}: {
    files: string[];
    sharedArgs: string[];
    workingRoot: string;
    runner: Runner;
}): Promise<{ findings: StepDiagnostic[] } | { error: string }> {
    if (files.length === 0) {
        return { findings: [] };
    }
    const check = await runner({
        cmd: "prettier",
        args: ["--check", ...sharedArgs, ...files],
        cwd: workingRoot,
    });
    if (check.status === 0) {
        return { findings: [] };
    }
    const findings = parsePrettierFindings({ stdout: check.stdout });
    if (findings.length === 0) {
        return {
            error: `node: prettier --check failed: ${failureDetail({
                result: check,
            })}`,
        };
    }
    return { findings };
}

/**
 * The house-config content cache for this pass, or undefined when caching is
 * off (fix pass, or no cache dir) or a consumer-owned prettier config makes the
 * tool's identity arbitrary — consumer configs bypass until their invalidation
 * inputs are defined (#68).
 */
function nodeFileCache({
    ctx,
    trackedFiles,
    workingRoot,
}: {
    ctx: NodeRunContext;
    trackedFiles: string[];
    workingRoot: string;
}): FileCache<boolean> | undefined {
    if (ctx.mode !== "no-fix" || ctx.cacheDir === undefined) {
        return undefined;
    }
    if (hasConsumerPrettierConfig({ files: trackedFiles })) {
        return undefined;
    }
    return createFileCache<boolean>({
        dir: ctx.cacheDir,
        step: "node",
        identity: identityHash({
            parts: prettierIdentityParts({ trackedFiles, workingRoot }),
        }),
    });
}

/**
 * Every input that can change prettier's per-file verdict: the pinned tool and
 * house config, the ignore policy (travelling plus a consumer .prettierignore),
 * and every tracked .editorconfig (prettier reads them natively and they
 * override --config).
 */
function prettierIdentityParts({
    trackedFiles,
    workingRoot,
}: {
    trackedFiles: string[];
    workingRoot: string;
}): Record<string, string> {
    const parts: Record<string, string> = {
        step: "prettier",
        tool: hashFile({ path: toolVersionsPath() }) ?? "unknown",
        config:
            hashFile({
                path: gateConfigPath({ name: "prettier.config.mjs" }),
            }) ?? "unknown",
        ignore:
            hashFile({ path: gateConfigPath({ name: "prettierignore" }) }) ??
            "unknown",
    };
    if (trackedFiles.includes(".prettierignore")) {
        parts["ignore-repo"] =
            hashFile({ path: join(workingRoot, ".prettierignore") }) ??
            "missing";
    }
    for (const file of trackedFiles) {
        if (file.split("/").pop() === ".editorconfig") {
            parts[`editorconfig:${file}`] =
                hashFile({ path: join(workingRoot, file) }) ?? "missing";
        }
    }
    return parts;
}
