// Tests for lib/coverage.mts: the percentage formatter shared by the coverage
// steps. Pure, so no fixtures or runner are needed.
// Run: node --test runtime/lib/coverage.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatPercent } from "./coverage.mts";

test("formatPercent keeps a round percentage at one decimal", () => {
    // Arrange
    const ROUND_RATIOS = [
        { numerator: 70, denominator: 100, expected: "70.0" },
        { numerator: 0, denominator: 100, expected: "0.0" },
        { numerator: 100, denominator: 100, expected: "100.0" },
    ];

    for (const { numerator, denominator, expected } of ROUND_RATIOS) {
        // Act
        const shown = formatPercent({ numerator, denominator });

        // Assert
        assert.equal(shown, expected);
    }
});

test("formatPercent floors at four decimals instead of rounding up", () => {
    // Arrange — each ratio is just under a value a rounding formatter would
    // print as meeting the next minimum.
    const FLOORED_RATIOS = [
        { numerator: 1, denominator: 3, expected: "33.3333" },
        { numerator: 899_999, denominator: 1_000_000, expected: "89.9999" },
        { numerator: 724, denominator: 2500, expected: "28.96" },
    ];

    for (const { numerator, denominator, expected } of FLOORED_RATIOS) {
        // Act
        const shown = formatPercent({ numerator, denominator });

        // Assert
        assert.equal(shown, expected);
    }
});

test("formatPercent accepts BigInt scaled-decimal counters", () => {
    // Arrange — a Cobertura rate 0.29 is the exact pair 29n / 100n.
    const numerator = 29n;
    const denominator = 100n;

    // Act
    const shown = formatPercent({ numerator, denominator });

    // Assert
    assert.equal(shown, "29.0");
});

test("formatPercent treats a zero denominator as zero percent", () => {
    // Arrange
    const numerator = 0;
    const denominator = 0;

    // Act
    const shown = formatPercent({ numerator, denominator });

    // Assert
    assert.equal(shown, "0.0");
});
