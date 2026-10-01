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

/** Consumer ESLint configuration (`.defined.json` `eslint` key). */
export interface EslintConfig {
    /** True switches the house ESLint step off for this repo. */
    disable?: boolean;
    /**
     * Cyclomatic-complexity ceiling for the house config's `complexity` rule:
     * a positive integer per-function max, or `false` to drop the rule.
     * Absent = the house default (10). Only the house config honours it — a
     * repo-owned config governs itself.
     */
    complexityMax?: number | false;
}

/** Consumer managed-workflow configuration (`.defined.json` `workflow` key). */
export interface WorkflowConfig {
    /**
     * True stops the gate installing and checking the managed gate workflow
     * (`.github/workflows/defined--verify.yml`) — for hosts that cannot run
     * it (Azure DevOps, GitLab, a private server). Local `comply` is
     * unaffected: every in-container step still runs.
     */
    disable?: boolean;
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
    /** ESLint switch. Absent key = the house ESLint step runs. */
    eslint?: EslintConfig;
    /** Managed-workflow switch. Absent key = the workflow is installed. */
    workflow?: WorkflowConfig;
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

const MINIMUM_METRICS = ["line", "branch", "function"] as const;

/** One metric entry: known name, numeric value in 0–100. */
function validateMinimumEntry(
    key: string,
    metric: string,
    value: unknown,
): void {
    if (!(MINIMUM_METRICS as readonly string[]).includes(metric)) {
        throw new Error(
            `.defined.json: unknown minimum metric "${metric}" in "coverage.${key}.minimums"`,
        );
    }
    if (typeof value !== "number" || value < 0 || value > 100) {
        throw new Error(
            `.defined.json: "coverage.${key}.minimums.${metric}" must be a number 0–100`,
        );
    }
}

function validateMinimums(
    key: string,
    raw: unknown,
): CoverageMinimums | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    const entry = expectObject(`coverage.${key}.minimums`, raw);
    const result: CoverageMinimums = {};
    for (const [metric, value] of Object.entries(entry)) {
        validateMinimumEntry(key, metric, value);
        result[metric as keyof CoverageMinimums] = value as number;
    }
    return result;
}

function validateCoverageEntry(key: string, raw: unknown): CoverageConfig {
    const entry = expectObject(`coverage.${key}`, raw);
    return {
        command: expectNonEmptyString(`coverage.${key}.command`, entry.command),
        minimums: validateMinimums(key, entry.minimums),
    };
}

function validateCoverage(raw: unknown): DefinedConfig["coverage"] {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    const coverage = expectObject("coverage", raw);
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

/** Throw when raw is not a plain JSON object; return it narrowed. */
function expectObject(where: string, raw: unknown): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new TypeError(`.defined.json: "${where}" must be an object`);
    }
    return raw as Record<string, unknown>;
}

/** Throw when value is not a non-empty string; return it narrowed. */
function expectNonEmptyString(where: string, value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`.defined.json: "${where}" must be a non-empty string`);
    }
    return value;
}

/** Throw when value is not a non-empty array; return it narrowed. */
function expectNonEmptyArray(where: string, value: unknown): unknown[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`.defined.json: "${where}" must be a non-empty array`);
    }
    return value;
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
    const entry = expectObject(where, raw);
    rejectUnknownKeys(entry, NODE_CHECK_KEYS, where);
    return {
        name: expectNonEmptyString(`${where}.name`, entry.name),
        command: expectNonEmptyString(`${where}.command`, entry.command),
        fix:
            entry.fix === undefined
                ? undefined
                : expectNonEmptyString(`${where}.fix`, entry.fix),
    };
}

/** A declared package dir: a string, normalised, `.` meaning the repo root. */
function validateNodePackageDir(where: string, value: unknown): string {
    if (typeof value !== "string") {
        throw new TypeError(`.defined.json: "${where}.dir" must be a string`);
    }
    const normalised = normaliseDir(value);
    return normalised === "." ? "" : normalised;
}

/** A dependency-restore command: a non-empty string, or `false` to skip. */
function validateNodePackageInstall(
    where: string,
    value: unknown,
): string | false {
    if (value === false) {
        return false;
    }
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
            `.defined.json: "${where}.install" must be a non-empty string or false`,
        );
    }
    return value;
}

function validateNodePackage(raw: unknown, where: string): NodePackageConfig {
    const entry = expectObject(where, raw);
    rejectUnknownKeys(entry, NODE_PACKAGE_KEYS, where);
    return {
        dir:
            entry.dir === undefined
                ? undefined
                : validateNodePackageDir(where, entry.dir),
        install:
            entry.install === undefined
                ? undefined
                : validateNodePackageInstall(where, entry.install),
        checks: expectNonEmptyArray(`${where}.checks`, entry.checks).map(
            (check, index) =>
                validateNodeCheck(`${where}.checks[${index}]`, check),
        ),
    };
}

/** The packages form: a non-empty array of package objects. */
function validateNodePackages(raw: unknown): NodeChecksConfig {
    return {
        packages: expectNonEmptyArray("node.packages", raw).map((pkg, index) =>
            validateNodePackage(pkg, `node.packages[${index}]`),
        ),
    };
}

function validateNode(raw: unknown): NodeChecksConfig | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    const entry = expectObject("node", raw);
    rejectUnknownKeys(entry, NODE_KEYS, "node");
    if (entry.packages !== undefined && entry.checks !== undefined) {
        throw new Error(
            `.defined.json: "node" cannot set both "packages" and "checks"`,
        );
    }
    if (entry.packages !== undefined) {
        return validateNodePackages(entry.packages);
    }
    if (entry.checks === undefined) {
        // `node` present but no checks declared: nothing to run, skip cleanly.
        return undefined;
    }
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

const NAMING_KEYS = new Set(["command", "fix"]);

function validateNaming(raw: unknown): NamingConfig | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    const entry = expectObject("naming", raw);
    rejectUnknownKeys(entry, NAMING_KEYS, "naming");
    const result: NamingConfig = {};
    for (const key of ["command", "fix"] as const) {
        if (entry[key] !== undefined) {
            result[key] = expectNonEmptyString(`naming.${key}`, entry[key]);
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
    const value = expectNonEmptyString(where, raw);
    const normalised = normaliseDir(value);
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

const ESLINT_KEYS = new Set(["disable", "complexityMax"]);

/** The complexity ceiling: a positive integer, or `false` to drop the rule. */
function validateComplexityMax(value: unknown): number | false {
    if (value === false) {
        return false;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new TypeError(
            `.defined.json: "eslint.complexityMax" must be a positive integer or false`,
        );
    }
    return value;
}

function validateEslint(raw: unknown): EslintConfig | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    const entry = expectObject("eslint", raw);
    rejectUnknownKeys(entry, ESLINT_KEYS, "eslint");
    const result: EslintConfig = {};
    if (entry.disable !== undefined) {
        if (typeof entry.disable !== "boolean") {
            throw new TypeError(
                `.defined.json: "eslint.disable" must be a boolean`,
            );
        }
        result.disable = entry.disable;
    }
    if (entry.complexityMax !== undefined) {
        result.complexityMax = validateComplexityMax(entry.complexityMax);
    }
    // `eslint` present but nothing declared: the house step still runs.
    return Object.keys(result).length === 0 ? undefined : result;
}

const WORKFLOW_KEYS = new Set(["disable"]);

function validateWorkflow(raw: unknown): WorkflowConfig | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new TypeError(`.defined.json: "workflow" must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    rejectUnknownKeys(entry, WORKFLOW_KEYS, "workflow");
    if (entry.disable === undefined) {
        // `workflow` present but nothing declared: the workflow still installs.
        return undefined;
    }
    if (typeof entry.disable !== "boolean") {
        throw new TypeError(
            `.defined.json: "workflow.disable" must be a boolean`,
        );
    }
    return { disable: entry.disable };
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
    const eslint = validateEslint(obj.eslint);
    const workflow = validateWorkflow(obj.workflow);
    return { version, coverage, node, naming, tofu, eslint, workflow };
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
