// Tests for lib/severities.mts: raises-only severity-floor maths.
// Run: node --test runtime/lib/severities.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { isAtLeastFloor, raiseFloor } from "./severities.mts";

test("values at or above the floor pass", () => {
    // Act & Assert
    assert.equal(isAtLeastFloor({ value: "warning", floor: "warning" }), true);
    assert.equal(isAtLeastFloor({ value: "error", floor: "warning" }), true);
});

test("values below the floor fail", () => {
    // Act & Assert
    assert.equal(isAtLeastFloor({ value: "info", floor: "warning" }), false);
    assert.equal(isAtLeastFloor({ value: "style", floor: "error" }), false);
});

test("raiseFloor keeps the stricter of two floors", () => {
    // Act & Assert
    assert.equal(
        raiseFloor({ current: "warning", requested: "error" }),
        "error",
    );
    assert.equal(raiseFloor({ current: "error", requested: "info" }), "error");
    assert.equal(
        raiseFloor({ current: "warning", requested: "warning" }),
        "warning",
    );
});

test("unknown severities throw instead of ranking as zero", () => {
    // Act & Assert
    assert.throws(
        () => isAtLeastFloor({ value: "catastrophic", floor: "error" }),
        /unknown severity/u,
    );
    assert.throws(
        () => raiseFloor({ current: "error", requested: "nope" }),
        /unknown severity/u,
    );
});
