// lib/timings.mts — opt-in monotonic timings for the gate (issue #71).
//
// The stdout contract is exactly one JSON result line and instrumentation never
// touches it: timings are human-readable lines on stderr, opt-in via
// `--timings`. Every duration comes from a monotonic clock (`performance.now`),
// so cold and warm runs compare without wall-clock skew. Labels are gate-owned
// phase/step names — never command text, arguments or environment — so no
// command credential can reach the log. Cache hit/miss metrics arrive with the
// caches (#67/#68); this module is the basic step/phase baseline first.

/** Destination for timing lines; the gate reports to stderr. */
export interface Timings {
    record(label: string, ms: number): void;
}

/** Monotonic milliseconds since process start; never a wall clock. */
export function now(): number {
    return performance.now();
}

function writeToStderr(line: string): void {
    process.stderr.write(`${line}\n`);
}

/**
 * A timings sink. Durations are rounded to whole milliseconds: they guide
 * optimisation, they are not a billing record.
 */
export function createTimings({
    sink = writeToStderr,
}: {
    sink?: (line: string) => void;
} = {}): Timings {
    return {
        record(label, ms) {
            sink(`defined: timing ${label} ${Math.round(ms)}ms`);
        },
    };
}

/**
 * Time `fn` under `label`, reporting its duration even when it throws. With no
 * timings object the work runs untouched — instrumentation is free when off.
 */
export async function measure<T>(
    timings: Timings | undefined,
    label: string,
    fn: () => T | Promise<T>,
): Promise<T> {
    if (!timings) {
        return fn();
    }
    const start = now();
    try {
        return await fn();
    } finally {
        timings.record(label, now() - start);
    }
}
