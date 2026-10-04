// runtime/lib/cache.mts — content-addressed per-file result cache (#68).
//
// Repeated gate iterations over a large git scope mostly reconsider files that
// did not change. House-config formatting (prettier) and linting (eslint) are
// per-file deterministic given a tool/config/ignore/env identity, so a file's
// verdict can be reused while its bytes and that identity are unchanged.
//
// The cache is a pure optimisation: a verdict is always rebuilt from per-file
// facts, any read/parse failure degrades to a miss, and a failed cache write is
// swallowed (it must never fail the gate). Consumer configs bypass it entirely
// until their invalidation inputs are defined (see the steps).
//
// A read-only `verify` mounts the repo `:ro`, so the cache lives outside the
// checkout: on the writable `DEFINED_CACHE_DIR` volume (default
// `~/.cache/defined`). One manifest per step; entries are keyed by
// `CACHE_FORMAT + identity + path + content hash`, and the manifest is rebuilt
// each run so it tracks exactly the current scope (deleted files drop out).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Env override for the cache root; tests and odd hosts point it elsewhere. */
export const CACHE_DIR_ENV = "DEFINED_CACHE_DIR";

/** Manifest format version; bump when an entry's meaning changes. */
export const CACHE_FORMAT = 1;

/** sha256 hex of a string or byte buffer. */
export function sha256Hex({ data }: { data: string | Buffer }): string {
    return createHash("sha256").update(data).digest("hex");
}

/**
 * The cache root: `DEFINED_CACHE_DIR` when set, else `<home>/.cache/defined`.
 * A blank override is ignored so an accidental empty variable cannot point the
 * cache at the process CWD.
 */
export function resolveCacheDir({
    env = process.env,
    home = homedir(),
}: {
    env?: NodeJS.ProcessEnv;
    home?: string;
} = {}): string {
    const override = env[CACHE_DIR_ENV];
    if (override !== undefined && override.trim() !== "") {
        return override;
    }
    return join(home, ".cache", "defined");
}

/**
 * A stable identity hash from labelled parts. Keys are sorted, so part order
 * never changes the digest; the values must carry every input that can change a
 * result (tool/plugin versions, effective config, ignore policy, env).
 */
export function identityHash({
    parts,
}: {
    parts: Record<string, string>;
}): string {
    const canonical = Object.keys(parts)
        // Explicit code-unit comparator (not localeCompare, which is
        // locale-dependent): the sort only needs to be deterministic and
        // order-independent, and it matches the default sort's ordering.
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => `${key}\u0000${parts[key]}`)
        .join("\u0001");
    return sha256Hex({ data: canonical });
}

/** Byte hash of a file, or undefined when it cannot be read (a cache miss). */
export function hashFile({
    path,
    readFileSyncFn = readFileSync,
}: {
    path: string;
    readFileSyncFn?: typeof readFileSync;
}): string | undefined {
    try {
        return sha256Hex({ data: readFileSyncFn(path) });
    } catch {
        return undefined;
    }
}

/** Per-file verdicts reused while a file's bytes and the identity are unchanged. */
export interface FileCache<T> {
    /** The cached verdict for a file at this content hash, or undefined. */
    lookup({ path, hash }: { path: string; hash: string }): T | undefined;
    /** Record a verdict for a file at this content hash. */
    record({ path, hash }: { path: string; hash: string }, value: T): void;
    /** Persist this run's entries; never throws (a cache failure is not a gate failure). */
    flush(): void;
    /** Lookups satisfied by the cache this run. */
    readonly hits: number;
    /** Lookups that had to be recomputed this run. */
    readonly misses: number;
}

/**
 * Split `paths` into the verdicts the cache already holds and the paths that
 * must be recomputed, hashing each file's working-root copy. A file that cannot
 * be read is a miss (the step's tool reports it if it matters). Shared by every
 * caching step so the hash-then-look-up rule lives in one place (#68).
 */
export function partitionByHash<T>({
    paths,
    workingRoot,
    cache,
}: {
    paths: string[];
    workingRoot: string;
    cache: FileCache<T>;
}): { cached: Map<string, T>; missing: string[]; hashes: Map<string, string> } {
    const cached = new Map<string, T>();
    const missing: string[] = [];
    const hashes = new Map<string, string>();
    for (const path of paths) {
        const hash = hashFile({ path: join(workingRoot, path) });
        if (hash === undefined) {
            missing.push(path);
            continue;
        }
        hashes.set(path, hash);
        const value = cache.lookup({ path, hash });
        if (value === undefined) {
            missing.push(path);
        } else {
            cached.set(path, value);
        }
    }
    return { cached, missing, hashes };
}

interface Manifest<T> {
    format: number;
    identity: string;
    entries: Record<string, T>;
}

/** Parse a manifest, treating a missing/corrupt/stale one as empty. */
function loadManifest<T>({
    manifestPath,
    identity,
    readFileSyncFn,
}: {
    manifestPath: string;
    identity: string;
    readFileSyncFn: typeof readFileSync;
}): Record<string, T> {
    try {
        const parsed = JSON.parse(readFileSyncFn(manifestPath, "utf8"));
        const manifest = parsed as Manifest<T>;
        if (
            manifest.format !== CACHE_FORMAT ||
            manifest.identity !== identity ||
            typeof manifest.entries !== "object" ||
            manifest.entries === null
        ) {
            return {};
        }
        return manifest.entries;
    } catch {
        return {};
    }
}

/** Write the manifest atomically (temp + rename); a failure is swallowed. */
function writeManifest<T>({
    manifestPath,
    identity,
    entries,
}: {
    manifestPath: string;
    identity: string;
    entries: Record<string, T>;
}): void {
    const manifest: Manifest<T> = { format: CACHE_FORMAT, identity, entries };
    const tmp = `${manifestPath}.${process.pid}.tmp`;
    try {
        mkdirSync(join(manifestPath, ".."), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify(manifest)}\n`);
        renameSync(tmp, manifestPath);
    } catch {
        // A cache that cannot be written is a lost optimisation, never a gate
        // failure (the volume may be read-only or full).
    }
}

/**
 * Open the per-step manifest under `dir` and return a cache keyed by
 * (identity, path, content hash). A missing, unreadable, corrupt or
 * differently-identified manifest starts empty; entries not touched this run
 * are dropped on flush, so the manifest tracks exactly the current scope.
 */
export function createFileCache<T>({
    dir,
    step,
    identity,
    readFileSyncFn = readFileSync,
}: {
    dir: string;
    step: string;
    identity: string;
    readFileSyncFn?: typeof readFileSync;
}): FileCache<T> {
    const manifestPath = join(dir, `${step}.json`);
    const loaded = loadManifest<T>({
        manifestPath,
        identity,
        readFileSyncFn,
    });
    const current = new Map<string, T>();
    let hits = 0;
    let misses = 0;
    const keyFor = ({ path, hash }: { path: string; hash: string }): string =>
        sha256Hex({
            data: `${CACHE_FORMAT}\u0000${identity}\u0000${path}\u0000${hash}`,
        });

    return {
        lookup({ path, hash }) {
            const key = keyFor({ path, hash });
            const value = Object.hasOwn(loaded, key) ? loaded[key] : undefined;
            if (value === undefined) {
                misses += 1;
                return undefined;
            }
            hits += 1;
            current.set(key, value);
            return value;
        },
        record({ path, hash }, value) {
            current.set(keyFor({ path, hash }), value);
        },
        flush() {
            writeManifest({
                manifestPath,
                identity,
                entries: Object.fromEntries(current),
            });
        },
        get hits() {
            return hits;
        },
        get misses() {
            return misses;
        },
    };
}

/**
 * Emit the cache hit/miss metric for a step. A no-op without a `notify` sink:
 * cache metrics ride the same opt-in `--timings` channel as phase durations
 * (#71), never the stdout result contract.
 */
export function reportCacheMetric({
    notify,
    step,
    cache,
}: {
    notify?: (line: string) => void;
    step: string;
    cache: Pick<FileCache<unknown>, "hits" | "misses">;
}): void {
    notify?.(`defined: cache ${step} hit=${cache.hits} miss=${cache.misses}`);
}
