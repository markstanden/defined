// Tests for lib/timings.mts: opt-in monotonic timing output (issue #71).
// Run: node --test lib/timings.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { createTimings, measure, now, type Timings } from "./timings.mts";

function collector(): { lines: string[]; timings: Timings } {
    const lines: string[] = [];
    return {
        lines,
        timings: createTimings({ sink: (line) => lines.push(line) }),
    };
}

test("record_writesOneLabelledMillisecondLine", () => {
    const { lines, timings } = collector();
    timings.record("comply fix", 12.6);
    assert.deepEqual(lines, ["defined: timing comply fix 13ms"]);
});

test("measure_reportsTheDurationAndReturnsTheValue", async () => {
    const { lines, timings } = collector();
    const value = await measure(timings, "fix/node", () => 42);
    assert.equal(value, 42);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^defined: timing fix\/node \d+ms$/u);
});

test("measure_reportsTheDurationEvenWhenTheWorkThrows", async () => {
    const { lines, timings } = collector();
    await assert.rejects(
        measure(timings, "fix/node", () => {
            throw new Error("boom");
        }),
        /boom/u,
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^defined: timing fix\/node \d+ms$/u);
});

test("measure_withoutTimings_runsTheWorkAndReportsNothing", async () => {
    const value = await measure(undefined, "fix/node", () => 7);
    assert.equal(value, 7);
});

test("now_isMonotonicNonDecreasing", () => {
    const first = now();
    const second = now();
    assert.ok(second >= first, "now() must never go backwards");
});
