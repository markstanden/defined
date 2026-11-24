// lib/proc.mts — asynchronous child-process execution for gate steps.
//
// Replaces the old spawnSync wrapper (issue #69): spawn + stream capture, so a
// long-running child never blocks the scheduler. Supports a per-command
// timeout, cooperative cancellation (AbortSignal) and bounded in-memory
// capture that keeps the head and tail of each stream — a failure summary at
// the end survives — and flags truncation explicitly.
//
// A child is spawned detached as its own process group and terminated as a
// group, so a timeout or cancellation takes any descendants with it. Missing
// binaries still throw loudly (naming the binary): per the no-optional-tier
// policy a tool the image should contain must exist, and its absence is a
// Containerfile problem, not a soft failure. Every other outcome — nonzero
// exit, signal, timeout, cancellation, truncation — is returned, never thrown.
//
// The spawn function is injectable so tests drive timeout, cancellation and
// capture deterministically, without real sleeps.

import { spawn, type ChildProcess } from "node:child_process";

/** Per-stream in-memory capture cap in bytes; output beyond it is elided. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** Inserted where captured output was elided, keeping head and tail legible. */
export const TRUNCATION_MARKER = "\n…[output truncated]…\n";

/** Fraction of the cap kept as the head; the remainder is kept as the tail. */
const HEAD_FRACTION = 0.6;

export interface CommandResult {
    /** Process exit code; null when signalled or never exited (a spawn error). */
    status: number | null;
    /** Everything the child wrote to stdout, bounded (see `truncated`). */
    stdout: string;
    /** Everything the child wrote to stderr, bounded (see `truncated`). */
    stderr: string;
    /** The signal that terminated the child, or null on a normal exit. */
    signal: NodeJS.Signals | null;
    /** True when the child was killed because its configured timeout elapsed. */
    timedOut: boolean;
    /** True when the child was killed because the caller aborted it. */
    cancelled: boolean;
    /** True when either stream exceeded the cap; its text keeps head + tail. */
    truncated: boolean;
}

/** The injectable spawn seam; production uses node:child_process's `spawn`. */
export type SpawnFn = typeof spawn;

export interface RunOptions {
    /** Executable to run; a bare name resolves on PATH. */
    cmd: string;
    /** Argument vector; never shell-interpolated. */
    args?: string[];
    /** Working directory; omitted inherits the parent's. */
    cwd?: string;
    /** Full child environment; omitted inherits the parent's. */
    env?: NodeJS.ProcessEnv;
    /** Hard timeout in ms; when it fires the whole process group is killed. */
    timeoutMs?: number;
    /** Cooperative cancellation; aborting kills the whole process group. */
    signal?: AbortSignal;
    /** Per-stream capture cap in bytes (default DEFAULT_MAX_OUTPUT_BYTES). */
    maxOutputBytes?: number;
}

/** A bounded per-stream accumulator: head + tail, with a truncation flag. */
interface Capture {
    /** Append one stream chunk, retaining at most the cap. */
    push(chunk: Buffer): void;
    /** True once more than the cap has arrived. */
    readonly truncated: boolean;
    /** The retained text; head + marker + tail when truncated. */
    text(): string;
}

/**
 * Build a bounded capture. Until the cap is reached it retains everything; past
 * it the head up to `HEAD_FRACTION` of the cap and the most recent tail are
 * kept, so both the opening context and the closing failure summary survive.
 */
function createCapture(capBytes: number): Capture {
    const headLimit = Math.max(1, Math.floor(capBytes * HEAD_FRACTION));
    const tailLimit = Math.max(1, capBytes - headLimit);
    const head: Buffer[] = [];
    const tail: Buffer[] = [];
    let headLen = 0;
    let tailLen = 0;
    let total = 0;

    const push = (chunk: Buffer): void => {
        total += chunk.length;
        let rest = chunk;
        if (headLen < headLimit) {
            const take = Math.min(headLimit - headLen, rest.length);
            head.push(rest.subarray(0, take));
            headLen += take;
            rest = rest.subarray(take);
        }
        if (rest.length > 0) {
            tail.push(rest);
            tailLen += rest.length;
            while (tailLen > tailLimit) {
                const overflow = tailLen - tailLimit;
                const first = tail[0]!;
                if (first.length <= overflow) {
                    tail.shift();
                    tailLen -= first.length;
                } else {
                    tail[0] = first.subarray(overflow);
                    tailLen -= overflow;
                }
            }
        }
    };

    return {
        push,
        get truncated() {
            return total > capBytes;
        },
        text() {
            const parts = [...head];
            if (total > capBytes) {
                parts.push(Buffer.from(TRUNCATION_MARKER));
            }
            parts.push(...tail);
            return Buffer.concat(parts).toString("utf8");
        },
    };
}

/**
 * Build an error for a child that could not be started. A missing binary gets
 * the actionable Containerfile hint; anything else keeps the OS message.
 */
function startError(cmd: string, err: unknown): Error {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
        code === "ENOENT"
            ? "not found in container — add it to runtime/Containerfile"
            : err instanceof Error
              ? err.message
              : String(err);
    return new Error(`cannot run '${cmd}': ${reason}`);
}

/**
 * Kill a child and its descendants: signal the whole process group the
 * detached child leads, falling back to the child itself when the group signal
 * fails (no pid, or the group is already gone).
 */
function terminate(child: ChildProcess): void {
    if (typeof child.pid === "number" && signalGroup(child.pid)) {
        return;
    }
    child.kill("SIGKILL");
}

/** Send SIGKILL to a process group; false when it could not be signalled. */
function signalGroup(pid: number): boolean {
    try {
        process.kill(-pid, "SIGKILL");
        return true;
    } catch {
        return false;
    }
}

/** Resolve/reject hooks for one run, plus the knobs its child needs. */
interface Settle {
    child: ChildProcess;
    cmd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxOutputBytes: number;
    resolve: (result: CommandResult) => void;
    reject: (err: Error) => void;
}

/**
 * Wire one spawned child to a promise: capture its streams, apply the timeout
 * and cancellation handlers, and resolve on close (or reject on a spawn error).
 */
function awaitChild({
    child,
    cmd,
    timeoutMs,
    signal,
    maxOutputBytes,
    resolve,
    reject,
}: Settle): void {
    const stdout = createCapture(maxOutputBytes);
    const stderr = createCapture(maxOutputBytes);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const kill = (): void => terminate(child);
    const timer =
        timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                  timedOut = true;
                  kill();
              }, timeoutMs);
    const onAbort = (): void => {
        cancelled = true;
        kill();
    };
    const cleanup = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted === true) {
        onAbort();
    } else {
        signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.once("error", (err: Error) => {
        if (settled) {
            return;
        }
        settled = true;
        cleanup();
        reject(startError(cmd, err));
    });
    child.once("close", (status: number | null, sig: NodeJS.Signals | null) => {
        if (settled) {
            return;
        }
        settled = true;
        cleanup();
        resolve({
            status,
            signal: sig,
            stdout: stdout.text(),
            stderr: stderr.text(),
            timedOut,
            cancelled,
            truncated: stdout.truncated || stderr.truncated,
        });
    });
}

/**
 * Run a command without blocking the event loop and capture its output. The
 * child leads its own process group (so timeout/cancellation can take
 * descendants down); a missing binary rejects loudly.
 */
export function run(
    {
        cmd,
        args = [],
        cwd,
        env,
        timeoutMs,
        signal,
        maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    }: RunOptions,
    spawnFn: SpawnFn = spawn,
): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        let child: ChildProcess;
        try {
            child = spawnFn(cmd, args, {
                cwd,
                env,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (err) {
            reject(startError(cmd, err));
            return;
        }
        awaitChild({
            child,
            cmd,
            timeoutMs,
            signal,
            maxOutputBytes,
            resolve,
            reject,
        });
    });
}

/**
 * A command result as actionable diagnostic text. Prefers stdout (test/build
 * failures land there), then stderr; when neither has text the cause still
 * shows. A non-plain outcome — timeout, cancellation, signal, truncation — is
 * named, so a killed or capped command can never read as bare "no output".
 */
export function failureDetail({ result }: { result: CommandResult }): string {
    const output =
        [result.stdout, result.stderr]
            .map((stream) => stream.trim())
            .filter((stream) => stream !== "")
            .join("\n") || "no output";
    const label = outcomeLabel({ result });
    return label === "" ? output : `${label}: ${output}`;
}

/** The outcome prefix failureDetail uses; empty for a plain zero exit. */
function outcomeLabel({ result }: { result: CommandResult }): string {
    const suffix = result.truncated ? " (output truncated)" : "";
    if (result.timedOut) {
        return `timed out${suffix}`;
    }
    if (result.cancelled) {
        return `cancelled${suffix}`;
    }
    if (result.signal !== null) {
        return `killed by ${result.signal}${suffix}`;
    }
    if (result.status === null) {
        return `did not exit${suffix}`;
    }
    return result.status === 0 ? "" : `exit ${result.status}${suffix}`;
}
