// Tests for lib/timings.mts: opt-in monotonic timing output (issue #71).
// Run: node --test runtime/lib/timings.test.mts

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
    // Arrange
    const { lines, timings } = collector();

    // Act
    timings.record("comply fix", 12.6);

    // Assert
    assert.deepEqual(lines, ["defined: timing comply fix 13ms"]);
});

test("measure_reportsTheDurationAndReturnsTheValue", async () => {
    // Arrange
    const { lines, timings } = collector();

    // Act
    const value = await measure(timings, "fix/node", () => 42);

    // Assert
    assert.equal(value, 42);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^defined: timing fix\/node \d+ms$/u);
});

test("measure_reportsTheDurationEvenWhenTheWorkThrows", async () => {
    // Arrange
    const { lines, timings } = collector();

    // Act & Assert — the throwing work is both exercised and asserted here.
    await assert.rejects(
        measure(timings, "fix/node", () => {
            throw new Error("boom");
        }),
        /boom/u,
    );

    // Assert — the timing line is still emitted despite the throw.
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^defined: timing fix\/node \d+ms$/u);
});

test("measure_withoutTimings_runsTheWorkAndReportsNothing", async () => {
    // Act
    const value = await measure(undefined, "fix/node", () => 7);

    // Assert
    assert.equal(value, 7);
});

test("now_isMonotonicNonDecreasing", () => {
    // Act
    const first = now();
    const second = now();

    // Assert
    assert.ok(second >= first, "now() must never go backwards");
});
