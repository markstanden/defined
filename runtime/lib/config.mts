// lib/config.mts — .defined.json reader and typed configuration.
//
// Reads the consumer's .defined.json at the repo root. The file is the single
// source of truth: it holds the optional immutable image pin (replacing the
// old .defined-version), optional per-ecosystem coverage configuration, and
// optional consumer Node project checks ("node" key).
//
// Version contract: an omitted `version` means "use the current published
// default image" (the launcher resolves it); a present `version` is an
// immutable pin and must be a 7–40 char hex SHA. The gate itself never uses
// the pin — only the launcher does — so an empty version is always valid here.
//
// Public surface:
//   loadConfig({ repoRoot })  — read + validate, or return empty config
//   CoverageConfig            — per-ecosystem coverage minimums
//   DefinedConfig             — full parsed config shape
//
// The runner is injected so tests need no filesystem.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_FILE = ".defined.json";

export interface CoverageMinimums {
    /** Line coverage percentage (0–100). Omitted = not checked. */
    line?: number;
    /** Branch coverage percentage (0–100). Omitted = not checked. */
    branch?: number;
    /** Function coverage percentage (0–100). Omitted = not checked. */
    function?: number;
}

export interface CoverageConfig {
    /** Shell command to generate coverage reports (fix mode). */
    command: string;
    /** Minimums to enforce. Omitted key = not checked. */
    minimums?: CoverageMinimums;
}

/** One consumer-declared Node check (lint/typecheck/test/...). */
export interface NodeCheck {
    /** Stable label used in gate output. */
    name: string;
    /** Shell command to run; resolved against the package's local binaries. */
    command: string;
    /** Optional deterministic autofix run before `command` in fix mode only. */
    fix?: string;
}

/** A Node package the checks run against. */
export interface NodePackageConfig {
    /**
     * Package directory relative to the repo root; `""` is the repo root.
     * Omitted means "the sole tracked package.json", whatever its depth.
     */
    dir?: string;
    /** Dependency-restore command; `false` skips restore; absent auto-detects. */
    install?: string | false;
    /** Checks to run, in order. */
    checks: NodeCheck[];
}

/** Node project-checks configuration (`.defined.json` `node` key). */
export interface NodeChecksConfig {
    packages: NodePackageConfig[];
}

/** Consumer-supplied naming rules (`.defined.json` `naming` key). */
export interface NamingConfig {
    /** Command that checks naming over the repo's git scope. */
    command?: string;
    /** Optional deterministic autofix run before `command` in fix mode only. */
    fix?: string;
}

/** Consumer OpenTofu module layout (`.defined.json` `tofu` key). */
export interface TofuConfig {
    /**
     * Module directories (repo-relative) to lint/init/validate. Absent means
     * auto-discover the top-most tracked `.tf` directories.
     */
    dirs?: string[];
}

export interface DefinedConfig {
    /**
     * Immutable image tag (7–40 hex chars). Empty when omitted — the launcher
     * then uses the current published default image (`latest`).
     */
    version: string;
    /** Per-ecosystem coverage configuration. Absent key = step skips. */
    coverage?: {
        node?: CoverageConfig;
        dotnet?: CoverageConfig;
    };
    /** Node project checks. Absent key = the node-checks step skips. */
    node?: NodeChecksConfig;
    /** Consumer naming rules. Absent key = no consumer rules. */
    naming?: NamingConfig;
    /** OpenTofu module layout. Absent key = auto-discover tracked .tf dirs. */
    tofu?: TofuConfig;
}

/** Empty config: all coverage steps skip, version is empty. */
const EMPTY: DefinedConfig = { version: "" };

const SHA_RE = /^[0-9a-f]{7,40}$/u;

function validateVersion(version: unknown): string {
    if (typeof version !== "string" || !SHA_RE.test(version)) {
        throw new Error(
            `.defined.json: "version" must be a 7–40 character hex SHA`,
        );
    }
    return version;
}

function validateMinimums(
    key: string,
    raw: unknown,
): CoverageMinimums | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new TypeError(
            `.defined.json: "coverage.${key}.minimums" must be an object`,
        );
    }
    const result: CoverageMinimums = {};
    for (const [metric, value] of Object.entries(
        raw as Record<string, unknown>,
    )) {
        if (metric !== "line" && metric !== "branch" && metric !== "function") {
            throw new Error(
                `.defined.json: unknown minimum metric "${metric}" in "coverage.${key}.minimums"`,
            );
        }
        if (typeof value !== "number" || value < 0 || value > 100) {
            throw new Error(
                `.defined.json: "coverage.${key}.minimums.${metric}" must be a number 0–100`,
            );
        }
        result[metric as keyof CoverageMinimums] = value;
    }
    return result;
}

function validateCoverageEntry(key: string, raw: unknown): CoverageConfig {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`.defined.json: "coverage.${key}" must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
        throw new Error(
            `.defined.json: "coverage.${key}.command" must be a non-empty string`,
        );
    }
    return {
        command: entry.command,
        minimums: validateMinimums(key, entry.minimums),
    };
}

function validateCoverage(raw: unknown): DefinedConfig["coverage"] {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new TypeError(`.defined.json: "coverage" must be an object`);
    }
    const coverage = raw as Record<string, unknown>;
    const result: NonNullable<DefinedConfig["coverage"]> = {};
    for (const [key, value] of Object.entries(coverage)) {
        if (key !== "node" && key !== "dotnet") {
            throw new Error(
                `.defined.json: unknown coverage ecosystem "${key}"`,
            );
        }
        result[key as keyof NonNullable<DefinedConfig["coverage"]>] =
            validateCoverageEntry(key, value);
    }
    return result;
}

const NODE_KEYS = new Set(["packages", "checks", "dir", "install"]);
const NODE_PACKAGE_KEYS = new Set(["dir", "install", "checks"]);
const NODE_CHECK_KEYS = new Set(["name", "command", "fix"]);

function rejectUnknownKeys(
    entry: Record<string, unknown>,
    allowed: Set<string>,
    where: string,
): void {
    for (const key of Object.keys(entry)) {
        if (!allowed.has(key)) {
            throw new Error(`.defined.json: unknown ${where} key "${key}"`);
        }
    }
}

/** Normalise a declared package dir: strip a leading "./" and trailing slashes. */
function normaliseDir(dir: string): string {
    let result = dir.startsWith("./") ? dir.slice(2) : dir;
    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }
    return result;
}

function validateNodeCheck(where: string, raw: unknown): NodeCheck {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`.defined.json: "${where}" must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    rejectUnknownKeys(entry, NODE_CHECK_KEYS, where);
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
        throw new Error(
            `.defined.json: "${where}.name" must be a non-empty string`,
        );
    }
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
        throw new Error(
            `.defined.json: "${where}.command" must be a non-empty string`,
        );
    }
    if (
        entry.fix !== undefined &&
        (typeof entry.fix !== "string" || entry.fix.trim() === "")
    ) {
        throw new Error(
            `.defined.json: "${where}.fix" must be a non-empty string`,
        );
    }
    return {
        name: entry.name,
        command: entry.command,
        fix: entry.fix as string | undefined,
    };
}

function validateNodePackage(raw: unknown, where: string): NodePackageConfig {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`.defined.json: "${where}" must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    rejectUnknownKeys(entry, NODE_PACKAGE_KEYS, where);

    let dir: string | undefined;
    if (entry.dir !== undefined) {
        if (typeof entry.dir !== "string") {
            throw new TypeError(
                `.defined.json: "${where}.dir" must be a string`,
            );
        }
        const normalised = normaliseDir(entry.dir);
        dir = normalised === "." ? "" : normalised;
    }

    let install: string | false | undefined;
    if (entry.install !== undefined) {
        if (entry.install === false) {
            install = false;
        } else if (
            typeof entry.install === "string" &&
            entry.install.trim() !== ""
        ) {
            install = entry.install;
        } else {
            throw new Error(
                `.defined.json: "${where}.install" must be a non-empty string or false`,
            );
        }
    }

    if (!Array.isArray(entry.checks) || entry.checks.length === 0) {
        throw new Error(
            `.defined.json: "${where}.checks" must be a non-empty array`,
        );
    }

    return {
        dir,
        install,
        checks: entry.checks.map((check, index) =>
            validateNodeCheck(`${where}.checks[${index}]`, check),
        ),
    };
}

function validateNode(raw: unknown): NodeChecksConfig | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new TypeError(`.defined.json: "node" must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    rejectUnknownKeys(entry, NODE_KEYS, "node");
    if (entry.packages !== undefined && entry.checks !== undefined) {
        throw new Error(
            `.defined.json: "node" cannot set both "packages" and "checks"`,
        );
    }
    if (entry.packages !== undefined) {
        if (!Array.isArray(entry.packages) || entry.packages.length === 0) {
            throw new Error(
                `.defined.json: "node.packages" must be a non-empty array`,
            );
        }
        return {
            packages: entry.packages.map((pkg, index) =>
                validateNodePackage(pkg, `node.packages[${index}]`),
            ),
        };
    }
    if (entry.checks !== undefined) {
        // Flat form: one package, whose directory may be inferred from the
        // sole tracked package.json when `dir` is omitted.
        return {
            packages: [
                validateNodePackage(
                    {
                        dir: entry.dir,
                        install: entry.install,
                        checks: entry.checks,
                    },
                    "node",
                ),
            ],
        };
    }
    // `node` present but no checks declared: nothing to run, so skip cleanly.
    return undefined;
}

const NAMING_KEYS = new Set(["command", "fix"]);

function validateNaming(raw: unknown): NamingConfig | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new TypeError(`.defined.json: "naming" must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    rejectUnknownKeys(entry, NAMING_KEYS, "naming");
    const result: NamingConfig = {};
    for (const key of ["command", "fix"] as const) {
        const value = entry[key];
        if (value !== undefined) {
            if (typeof value !== "string" || value.trim() === "") {
                throw new Error(
                    `.defined.json: "naming.${key}" must be a non-empty string`,
                );
            }
            result[key] = value;
        }
    }
    // An empty `naming` object declares nothing: treat it as absent.
    if (Object.keys(result).length === 0) {
        return undefined;
    }
    if (result.fix !== undefined && result.command === undefined) {
        throw new Error(
            `.defined.json: "naming.fix" requires "naming.command"`,
        );
    }
    return result;
}

const TOFU_KEYS = new Set(["dirs"]);

/** A repo-relative, non-escaping module directory. `.` is the repo root. */
function validateTofuDir(where: string, raw: unknown): string {
    if (typeof raw !== "string" || raw.trim() === "") {
        throw new Error(`.defined.json: "${where}" must be a non-empty string`);
    }
    const normalised = normaliseDir(raw);
    if (
        normalised === "" ||
        normalised === ".." ||
        normalised.startsWith("../") ||
        normalised.startsWith("/")
    ) {
        throw new Error(
            `.defined.json: "${where}" must be a repo-relative directory`,
        );
    }
    return normalised;
}

function validateTofu(raw: unknown): TofuConfig | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new TypeError(`.defined.json: "tofu" must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    rejectUnknownKeys(entry, TOFU_KEYS, "tofu");
    if (entry.dirs === undefined) {
        // `tofu` present but nothing declared: auto-discovery applies.
        return undefined;
    }
    if (!Array.isArray(entry.dirs) || entry.dirs.length === 0) {
        throw new Error(`.defined.json: "tofu.dirs" must be a non-empty array`);
    }
    return {
        dirs: entry.dirs.map((dir, index) =>
            validateTofuDir(`tofu.dirs[${index}]`, dir),
        ),
    };
}

function validateParsed(raw: unknown): DefinedConfig {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`.defined.json: must be a JSON object`);
    }
    const obj = raw as Record<string, unknown>;
    // Omitted version = "use the current published default image". A present
    // version must be an immutable pin; empty/null/non-string are errors.
    const version =
        obj.version === undefined ? "" : validateVersion(obj.version);
    const coverage = validateCoverage(obj.coverage);
    const node = validateNode(obj.node);
    const naming = validateNaming(obj.naming);
    const tofu = validateTofu(obj.tofu);
    return { version, coverage, node, naming, tofu };
}

/**
 * Read and validate .defined.json from repoRoot. Returns empty config when the
 * file is absent (coverage steps skip). Throws on malformed content.
 */
export async function loadConfig({
    repoRoot,
    readFileFn = readFile,
}: {
    repoRoot: string;
    readFileFn?: typeof readFile;
}): Promise<DefinedConfig> {
    const path = join(repoRoot, CONFIG_FILE);
    if (!existsSync(path)) {
        return EMPTY;
    }
    const content = await readFileFn(path, "utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error(`.defined.json: invalid JSON`);
    }
    return validateParsed(parsed);
}
