// Tests for lib/proc.mts: asynchronous child-process execution for steps.
// Run: node --test lib/proc.test.mts
//
// Real children prove the spawn/stream/group-kill wiring (success, exit,
// missing binary, signal, timeout with a descendant, bounded output). The
// injected spawn seam proves cancellation deterministically, with no sleep.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
    failureDetail,
    run,
    TRUNCATION_MARKER,
    type CommandResult,
    type SpawnFn,
} from "./proc.mts";

/** A shared baseline so each failureDetail case names only what it varies. */
function result(overrides: Partial<CommandResult> = {}): CommandResult {
    return {
        status: 0,
        stdout: "",
        stderr: "",
        signal: null,
        timedOut: false,
        cancelled: false,
        truncated: false,
        ...overrides,
    };
}

/** A controllable stand-in for a spawned child, used through the spawn seam. */
class FakeChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    /** No pid, so terminate() uses the child's own kill (never a real group). */
    pid: number | undefined = undefined;
    /** Every signal terminate() sent, in order. */
    signals: Array<NodeJS.Signals | undefined> = [];

    kill(signal?: NodeJS.Signals): boolean {
        this.signals.push(signal);
        // Resolve the pending close asynchronously, like a real child.
        queueMicrotask(() => this.emit("close", null, signal ?? "SIGKILL"));
        return true;
    }
}

/** A spawn seam that always hands out the given fake child. */
function spawnThat(child: FakeChild): SpawnFn {
    return (() => child) as unknown as SpawnFn;
}

test("run captures output of a successful command", async () => {
    // Act
    const result = await run({
        cmd: "node",
        args: ["-e", "console.log('hello')"],
    });

    // Assert
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "hello");
    assert.equal(result.stderr, "");
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    assert.equal(result.truncated, false);
});

test("run reports a non-zero exit without throwing", async () => {
    // Act
    const result = await run({
        cmd: "node",
        args: ["-e", "console.error('boom'); process.exit(3)"],
    });

    // Assert
    assert.equal(result.status, 3);
    assert.equal(result.stderr.trim(), "boom");
});

test("run rejects loudly when the binary is missing", async () => {
    // Act & Assert
    await assert.rejects(
        run({ cmd: "definitely-not-a-real-tool-xyz" }),
        /cannot run 'definitely-not-a-real-tool-xyz'.*not found in container/u,
    );
});

test("run reports a synchronous spawn failure with its message", async () => {
    // Arrange
    const spawnFn = (() => {
        throw new Error("EACCES: permission denied");
    }) as unknown as SpawnFn;

    // Act & Assert
    await assert.rejects(
        run({ cmd: "tool" }, spawnFn),
        /cannot run 'tool': EACCES: permission denied/u,
    );
});

test("run honours cwd for the invoked command", async () => {
    // Act
    const result = await run({ cmd: "pwd", cwd: "/tmp" });

    // Assert
    assert.equal(result.stdout.trim(), "/tmp");
});

test("run passes a supplied environment to the command", async () => {
    // Act
    const result = await run({
        cmd: "/bin/sh",
        args: ["-c", "printf '%s' \"$DEFINED_TEST_ENV\""],
        env: { DEFINED_TEST_ENV: "local-bin" },
    });

    // Assert
    assert.equal(result.stdout, "local-bin");
});

test("run reports the signal that terminated the child", async () => {
    // Act
    const result = await run({
        cmd: "node",
        args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
    });

    // Assert
    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
});

test("run times out and kills the whole process group", async () => {
    // Act — start the shell and wait for the timeout to fire.
    // A shell with a long-lived descendant: if only the shell were killed the
    // still-open pipe would keep close from firing for 30s. Resolving promptly
    // proves the group (shell + sleep) was terminated.
    const result = await run({
        cmd: "sh",
        args: ["-c", "sleep 30"],
        timeoutMs: 150,
    });

    // Assert
    assert.equal(result.timedOut, true);
    assert.equal(result.status, null);
    assert.notEqual(result.signal, null);
});

test("run cancels a running child when the signal aborts", async () => {
    // Arrange — a child held open behind the injected spawn seam.
    const child = new FakeChild();
    const controller = new AbortController();
    const promise = run(
        { cmd: "tool", signal: controller.signal },
        spawnThat(child),
    );

    // Act
    controller.abort();

    // Assert
    const result = await promise;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.status, null);
    assert.deepEqual(child.signals, ["SIGKILL"]);
});

test("run cancels at once when the signal is already aborted", async () => {
    // Arrange — the signal is aborted before the run is even requested.
    const child = new FakeChild();
    const controller = new AbortController();
    controller.abort();

    // Act
    const result = await run(
        { cmd: "tool", signal: controller.signal },
        spawnThat(child),
    );

    // Assert
    assert.equal(result.cancelled, true);
    assert.deepEqual(child.signals, ["SIGKILL"]);
});

test("run bounds captured output and flags truncation", async () => {
    // Act
    const result = await run({
        cmd: "node",
        args: [
            "-e",
            "process.stdout.write('a'.repeat(4000)); process.stderr.write('b'.repeat(4000))",
        ],
        maxOutputBytes: 1000,
    });

    // Assert
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.startsWith("a"), "head is retained");
    assert.ok(result.stdout.includes(TRUNCATION_MARKER), "elision is marked");
    assert.ok(result.stderr.includes(TRUNCATION_MARKER));
});

test("failureDetail names the outcome and keeps the output", () => {
    // Arrange
    const cases: Array<{ input: CommandResult; expected: string }> = [
        {
            input: result({ status: 3, stderr: "boom" }),
            expected: "exit 3: boom",
        },
        {
            input: result({ status: null, signal: "SIGKILL" }),
            expected:
                "killed by SIGKILL: no output — no diagnostics captured; a reporter may have consumed them",
        },
        {
            input: result({ status: null, timedOut: true }),
            expected:
                "timed out: no output — no diagnostics captured; a reporter may have consumed them",
        },
        {
            input: result({ status: null, cancelled: true }),
            expected:
                "cancelled: no output — no diagnostics captured; a reporter may have consumed them",
        },
        {
            input: result({ status: null }),
            expected:
                "did not exit: no output — no diagnostics captured; a reporter may have consumed them",
        },
        {
            input: result({ status: 1 }),
            expected:
                "exit 1: no output — no diagnostics captured; a reporter may have consumed them",
        },
        {
            input: result({ status: 1, stderr: "x", truncated: true }),
            expected: "exit 1 (output truncated): x",
        },
        {
            input: result({ status: 0, stdout: "hi", truncated: true }),
            expected: "hi",
        },
    ];

    // Act
    const details = cases.map(({ input }) => failureDetail({ result: input }));

    // Assert
    assert.deepEqual(
        details,
        cases.map(({ expected }) => expected),
    );
});
