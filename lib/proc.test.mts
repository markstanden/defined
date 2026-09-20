// Tests for lib/proc.mts: child-process execution used by steps.
// Run: node --test lib/proc.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { run } from "./proc.mts";

test("run captures output of a successful command", () => {
    const result = run({ cmd: "node", args: ["-e", "console.log('hello')"] });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "hello");
    assert.equal(result.stderr, "");
});

test("run reports non-zero status without throwing", () => {
    const result = run({
        cmd: "node",
        args: ["-e", "console.error('boom'); process.exit(3)"],
    });
    assert.equal(result.status, 3);
    assert.equal(result.stderr.trim(), "boom");
});

test("run throws loudly when the binary is missing", () => {
    assert.throws(
        () => run({ cmd: "definitely-not-a-real-tool-xyz" }),
        /definitely-not-a-real-tool-xyz/u,
    );
});

test("run honours cwd for the invoked command", () => {
    const result = run({ cmd: "pwd", cwd: "/tmp" });
    assert.equal(result.stdout.trim(), "/tmp");
});

test("run passes a supplied environment to the command", () => {
    const result = run({
        cmd: "sh",
        args: ["-c", "printf '%s' \"$DEFINED_TEST_ENV\""],
        env: { ...process.env, DEFINED_TEST_ENV: "local-bin" },
    });
    assert.equal(result.stdout, "local-bin");
});
