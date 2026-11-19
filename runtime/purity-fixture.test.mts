// Integration test: the opt-in purity/CQS step against the real baked rules.
//
// Two container runs, both through runtime/comply.sh:
//   1. a deliberately impure/CQS-breaking consumer with eslint disabled, a repo
//      config that ignores the tree, and an inline suppression — every opted-in
//      finding must still be reported, green files stay clean, and read-only
//      verify must not touch the checkout;
//   2. the repaired consumer: the file read moves to the caller, the CQS
//      contract is satisfiable, purity passes while an ordinary ESLint finding
//      still fails the eslint step.
//
// Also proves `defined explain` serves the new step/rule guidance offline.
// Requires a container engine + the gate image (comply.sh builds it on first
// run); skips cleanly on a bare machine, like fixture.test.mts.
// Run: node --test runtime/purity-fixture.test.mts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

import { run } from "../lib/proc.mts";

function hasEngine(): boolean {
    if (process.env.ACT === "true") {
        return false;
    }
    return existsSync("/usr/bin/podman") || existsSync("/usr/bin/docker");
}

function gateShim(): string {
    return resolve(import.meta.dirname, "comply.sh");
}

interface GateError {
    check: string;
    kind: string;
    file?: string;
    line?: number;
    column?: number;
    rule?: string;
    message: string;
}

interface GateResult {
    status: string;
    results: Record<string, string>;
    errors?: GateError[];
}

function parseGate(stdout: string): GateResult {
    const line = stdout.trim().split("\n").filter(Boolean).at(-1);
    assert.ok(line, "the gate must print a JSON result line");
    return JSON.parse(line!) as GateResult;
}

function hashTree(root: string): Map<string, string> {
    const hashes = new Map<string, string>();
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                hashes.set(
                    relative(root, full),
                    createHash("sha256")
                        .update(readFileSync(full))
                        .digest("hex"),
                );
            }
        }
    };
    walk(root);
    return hashes;
}

async function makeGitRepo(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "quality-purity-fixture-"));
    for (const [path, content] of Object.entries(files)) {
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir !== "") {
            await mkdir(join(root, dir), { recursive: true });
        }
        await writeFile(join(root, path), content);
    }
    for (const args of [
        ["init", "-q"],
        ["config", "user.email", "fixture@test"],
        ["config", "user.name", "fixture"],
        ["config", "maintenance.auto", "false"],
        ["config", "gc.auto", "0"],
        ["add", "-A"],
        ["commit", "-qm", "fixture"],
    ]) {
        const result = await run({ cmd: "git", args, cwd: root });
        assert.equal(
            result.status,
            0,
            `git ${args.join(" ")}: ${result.stderr}`,
        );
    }
    return root;
}

const RED_FILES: Record<string, string> = {
    "eslint.config.mjs": 'export default [{ ignores: ["lib/**"] }];\n',
    ".defined.json": `${JSON.stringify(
        {
            eslint: { disable: true },
            purity: {
                pureModules: ["lib/pure/**/*.mts", "lib/pure/imports.mts"],
                commands: [
                    { file: "lib/receipts.mts", name: "saveReceipt" },
                    { file: "lib/receipts.mts", name: "saveExpression" },
                    { file: "lib/receipts.mts", name: "savePayload" },
                    { file: "lib/receipts.mts", name: "saveAndReturn" },
                    { file: "lib/receipts.mts", name: "saveWithCallback" },
                    { file: "lib/receipts.mts", name: "saveUndefined" },
                    { file: "lib/receipts.mts", name: "saveVoid" },
                    { file: "lib/receipts.mts", name: "saveShadowed" },
                    { file: "lib/receipts.mts", name: "saveStale" },
                    { file: "lib/receipts.mts", name: "saveOverload" },
                    { file: "lib/receipts.mts", name: "saveMethod" },
                    { file: "lib/receipts.mts", name: "saveGenerator" },
                    { file: "lib/receipts.mts", name: "saveLet" },
                ],
                queries: [
                    { file: "lib/receipts.mts", name: "readPersisted" },
                    { file: "lib/receipts.mts", name: "readDerived" },
                    { file: "lib/receipts.mts", name: "readSum" },
                    { file: "lib/receipts.mts", name: "writeCache" },
                    { file: "lib/receipts.mts", name: "readAndMutate" },
                ],
            },
        },
        null,
        4,
    )}\n`,
    "lib/pure/imports.mts": [
        'import { readFile } from "node:fs/promises";',
        'import "node:fs";',
        'import fs from "fs";',
        'import { stat } from "fs/promises";',
        'export { readFile as read } from "node:fs/promises";',
        'export * from "node:events";',
        'import os = require("node:os");',
        'const literal = import("node:fs");',
        'const computed = import(`node:${"fs"}`);',
        'const loader = require("node:os");',
        "export const keep = [readFile, fs, stat, os, literal, computed, loader];",
        "",
    ].join("\n"),
    "lib/pure/ambient.mts": [
        "export function readEnv() { return process.env.X; }",
        'export function log() { console.log("x"); }',
        'export function load() { return fetch("x"); }',
        "export function later() { setTimeout(() => {}, 0); }",
        "export function tick() { return setInterval(() => {}, 0); }",
        "export function soon() { setImmediate(() => {}); }",
        "export function stamp() { return Date(); }",
        "export function stampArg() { return Date(1); }",
        "export function now() { return new Date(); }",
        "export function nowMs() { return Date.now(); }",
        "export function random() { return Math.random(); }",
        "export function viaGlobal() { return globalThis.process.env.X; }",
        'export function viaKey() { return globalThis["console"]; }',
        "export function globalNow() { return globalThis.Date.now(); }",
        'export function globalRandom() { return globalThis["Math"]["random"](); }',
        "",
    ].join("\n"),
    "lib/pure/shadow.mts": [
        "export function read(process: { env: string }) { return process.env; }",
        'export function say(console: { log: (value: string) => void }) { console.log("x"); }',
        "export function rand() { const Math = { random: () => 0 }; return Math.random(); }",
        "export function call({ Date }: { Date: () => number }) { return Date(); }",
        "export const biggest = Math.max(1, 2);",
        "export const epoch = new Date(0);",
        'export const parsed = Date.parse("2020-01-01");',
        "",
    ].join("\n"),
    "lib/pure/mutate.mts": [
        "export function assign(input: { count: number }) { input.count = 1; }",
        "export function update(input: { count: number }) { input.count++; }",
        "export function remove(input: { count: number }) { delete input.count; }",
        "export function local(input: { items: number[] }) { const out = [...input.items]; out.push(1); return out; }",
        "",
    ].join("\n"),
    "lib/pure/alias.mts": [
        "export function alias(input: { count: number }) { const target = input; target.count = 1; return target; }",
        'export function injected(repo: { write: (value: string) => void }) { repo.write("x"); }',
        "",
    ].join("\n"),
    "lib/pure/type-only.mts": [
        'import type { Stats } from "node:fs";',
        'import { type PathLike } from "node:path";',
        'export type { Stats as S } from "node:fs";',
        'export { type PathLike as P } from "node:path";',
        'export type * from "node:stream";',
        'import type os = require("node:os");',
        'export type X = typeof import("node:fs");',
        "export type F = typeof os;",
        "export const constant = 1;",
        "",
    ].join("\n"),
    "lib/pure/with space.mts": [
        'import { join } from "node:path";',
        "export const path = join;",
        "",
    ].join("\n"),
    "lib/pure/suppressed.mts": [
        "// eslint-disable-next-line defined/pure-module",
        'import { readFile } from "node:fs/promises";',
        "export const keep = readFile;",
        "",
    ].join("\n"),
    "lib/pure/helper.mts": [
        'import { double } from "./double.mts";',
        "export function compute(value: number) { return double(value); }",
        "",
    ].join("\n"),
    "lib/pure/double.mts": [
        "export function double(value: number) { return value * 2; }",
        "",
    ].join("\n"),
    "lib/pure/wrapper.mts": [
        'import { readText } from "../adapters/io.mts";',
        'export function load() { return readText("x"); }',
        "",
    ].join("\n"),
    "lib/adapters/io.mts": [
        'import { readFile } from "node:fs/promises";',
        'export async function readText(path: string) { return readFile(path, "utf8"); }',
        "",
    ].join("\n"),
    "lib/not-selected/shell.mts": [
        'import { readFile } from "node:fs/promises";',
        "export const keep = readFile;",
        "",
    ].join("\n"),
    "lib/receipts.mts": [
        "let cache = 0;",
        "",
        "export async function saveReceipt(input: string): Promise<void> {",
        "    cache = input.length;",
        "}",
        "",
        "export const saveExpression = () => 42;",
        "",
        "export const savePayload = async () => ({ ok: true });",
        "",
        "export const saveShadowed = () => {",
        "    const undefined = 1;",
        "    return undefined;",
        "};",
        "",
        "export const saveUndefined = () => undefined;",
        "",
        "export const saveVoid = () => {",
        "    return void saveUndefined();",
        "};",
        "",
        "export function saveWithCallback(): void {",
        "    [1, 2].map((value) => value * 2);",
        "}",
        "",
        "export function saveAndReturn(state: { count: number }) {",
        "    state.count += 1;",
        "    return state.count;",
        "}",
        "",
        "export const readPersisted = (): number => cache;",
        "",
        "export function readDerived(input: number): number {",
        "    return input * 2;",
        "}",
        "",
        "export function readSum(values: number[]): number {",
        "    let total = 0;",
        "    for (const value of values) {",
        "        total += value;",
        "    }",
        "    return total;",
        "}",
        "",
        "export function writeCache(value: number): void {",
        "    cache = value;",
        "}",
        "",
        "export function readAndMutate(input: { count: number }): number {",
        "    input.count += 1;",
        "    return input.count;",
        "}",
        "",
        "export function saveOverload(value: string): void;",
        "export function saveOverload(value: number): void;",
        "",
        "export function* saveGenerator() {",
        "    yield 1;",
        "}",
        "",
        "export let saveLet = () => 1;",
        "",
        "export class Store {",
        "    saveMethod(): number {",
        "        cache += 1;",
        "        return cache;",
        "    }",
        "}",
        "",
    ].join("\n"),
};

const GREEN_FILES: Record<string, string> = {
    ".defined.json": `${JSON.stringify(
        {
            purity: {
                pureModules: ["lib/status.mts"],
                commands: [
                    { file: "lib/receipts.mts", name: "saveReceipt" },
                    { file: "lib/receipts.mts", name: "saveWithCallback" },
                ],
                queries: [
                    { file: "lib/receipts.mts", name: "readPersisted" },
                    { file: "lib/receipts.mts", name: "readDerived" },
                ],
            },
        },
        null,
        4,
    )}\n`,
    "lib/status.mts": [
        "export function deriveStatus(contents: string): string {",
        '    return contents.trim() === "" ? "empty" : "ok";',
        "}",
        "",
    ].join("\n"),
    "lib/caller.mts": [
        'import { readFile } from "node:fs/promises";',
        'import { deriveStatus } from "./status.mts";',
        "",
        "export async function readStatus(path: string): Promise<string> {",
        '    return deriveStatus(await readFile(path, "utf8"));',
        "}",
        "",
    ].join("\n"),
    "lib/receipts.mts": [
        "let cache = 0;",
        "",
        "export async function saveReceipt(input: string): Promise<void> {",
        "    cache = input.length;",
        "}",
        "",
        "export function saveWithCallback(): void {",
        "    [1, 2].map((value) => value * 2);",
        "}",
        "",
        "export const readPersisted = (): number => cache;",
        "",
        "export function readDerived(input: number): number {",
        "    return input * 2;",
        "}",
        "",
    ].join("\n"),
    "lib/unrelated.mts": [
        "const unused = 1;",
        "export const value = 2;",
        "",
    ].join("\n"),
};

test(
    "purity reports every opted-in finding despite a consumer ignore, inline suppression and disabled ESLint",
    { skip: !hasEngine() },
    async () => {
        const root = await makeGitRepo(RED_FILES);
        try {
            const before = hashTree(root);
            const check = await run({
                cmd: gateShim(),
                args: ["--check-only", "--full"],
                cwd: root,
            });
            assert.equal(
                check.status,
                1,
                `the impure fixture must fail, got:\n${check.stdout}`,
            );
            const gate = parseGate(check.stdout);
            assert.equal(gate.results.purity, "fail");
            const errors = (gate.errors ?? []).filter(
                (error) => error.check === "purity",
            );

            const byFile = (file: string): GateError[] =>
                errors.filter((error) => error.file === file);

            // Runtime dependencies: every import/loader form is red.
            const imports = byFile("lib/pure/imports.mts");
            assert.equal(imports.length, 10);
            assert.ok(
                imports.every((error) => error.rule === "defined/pure-module"),
            );
            assert.ok(
                imports.some(
                    (error) =>
                        error.line === 1 &&
                        error.message.includes('"node:fs/promises"'),
                ),
                "the first finding must name the built-in and the remedy",
            );

            // Ambient effects, including globalThis and literal keys.
            assert.equal(byFile("lib/pure/ambient.mts").length, 15);
            // Direct parameter writes only: a local accumulator is clean.
            assert.equal(byFile("lib/pure/mutate.mts").length, 3);
            // The documented limits stay green: aliases and injected effects.
            assert.equal(byFile("lib/pure/alias.mts").length, 0);
            // Type-only specifiers and a relative pure helper stay green.
            assert.equal(byFile("lib/pure/type-only.mts").length, 0);
            assert.equal(byFile("lib/pure/helper.mts").length, 0);
            assert.equal(byFile("lib/pure/wrapper.mts").length, 0);
            // A selector with spaces is real, not a glob accident.
            assert.equal(byFile("lib/pure/with space.mts").length, 1);
            // Inline suppression does not silence the baked rule.
            assert.equal(byFile("lib/pure/suppressed.mts").length, 1);
            // The relative wrapper blind spot is documented, and the adapter
            // shell is not selected.
            assert.equal(byFile("lib/adapters/io.mts").length, 0);
            assert.equal(byFile("lib/not-selected/shell.mts").length, 0);

            // CQS: value-bearing returns, captured writes and parameter writes.
            const receipts = byFile("lib/receipts.mts");
            assert.equal(
                receipts.filter((error) => error.rule === "defined/cqs-command")
                    .length,
                4,
                "expression arrows, async payloads, a return after mutation and a shadowed undefined must all fail",
            );
            assert.equal(
                receipts.filter((error) => error.rule === "defined/cqs-query")
                    .length,
                2,
            );
            const targets = receipts.filter(
                (error) => error.rule === "defined/cqs-targets",
            );
            assert.equal(targets.length, 5);
            assert.ok(
                targets.some((error) => error.message.includes('"saveStale"')),
            );
            assert.ok(
                targets.some((error) =>
                    error.message.includes("only overload signatures"),
                ),
            );

            // Read-only verify never writes to the checkout.
            assert.deepEqual([...hashTree(root)].sort(), [...before].sort());

            // Repair cannot erase the finding: purity is skipped in the repair
            // pass and re-judged in the authoritative verification pass.
            const complied = await run({
                cmd: gateShim(),
                args: ["--full"],
                cwd: root,
            });
            const repaired = parseGate(complied.stdout);
            assert.equal(repaired.results.purity, "fail");
            assert.ok(
                (repaired.errors ?? []).some(
                    (error) =>
                        error.check === "purity" &&
                        error.file === "lib/pure/imports.mts" &&
                        error.rule === "defined/pure-module",
                ),
                "an unrelated repair must not erase the purity finding",
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

test(
    "a repaired consumer passes purity while an ordinary ESLint finding still fails the lint step",
    { skip: !hasEngine() },
    async () => {
        const root = await makeGitRepo(GREEN_FILES);
        try {
            const check = await run({
                cmd: gateShim(),
                args: ["--check-only", "--full"],
                cwd: root,
            });
            const gate = parseGate(check.stdout);
            assert.equal(gate.results.purity, "pass");
            assert.equal(gate.results.eslint, "fail");
            assert.ok(
                (gate.errors ?? []).some(
                    (error) =>
                        error.check === "eslint" &&
                        error.file === "lib/unrelated.mts" &&
                        error.rule === "@typescript-eslint/no-unused-vars",
                ),
                "the ordinary ESLint step must still report its own finding",
            );
            assert.equal(
                (gate.errors ?? []).some((error) => error.check === "purity"),
                false,
                "a clean opt-in consumer must produce no purity diagnostics",
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

test(
    "explain serves the purity step and rule guidance offline from the pinned image",
    { skip: !hasEngine() },
    async () => {
        const root = await makeGitRepo({
            ".defined.json": "{}\n",
        });
        try {
            for (const [topic, kind] of [
                ["purity", "step"],
                ["defined/pure-module", "rule"],
                ["defined/cqs-command", "rule"],
            ] as const) {
                const explained = await run({
                    cmd: gateShim(),
                    args: ["explain", topic],
                    cwd: root,
                });
                assert.equal(explained.status, 0, explained.stderr);
                const answer = JSON.parse(explained.stdout.trim()) as {
                    kind: string;
                    doc: string;
                    guidance: string;
                };
                assert.equal(answer.kind, kind);
                assert.equal(answer.doc, "standards/node-purity.md");
                assert.match(answer.guidance, /defined\/pure-module/u);
                assert.match(answer.guidance, /defined\/cqs-query/u);
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
