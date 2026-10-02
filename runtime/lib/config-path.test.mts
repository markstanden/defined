// Tests for runtime/lib/config-path.mts: runtime config dir resolution.
// Run: node --test runtime/lib/config-path.test.mts

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { gateConfigPath, standardsDir } from "./config-path.mts";

test("gateConfigPath resolves under the runtime's own config directory", () => {
    const path = gateConfigPath({ name: "yamllint.yml" });
    assert.match(path, /\/config\/yamllint\.yml$/u);
    assert.equal(existsSync(path), true);
});

test("standardsDir resolves to the sibling standards directory", () => {
    const dir = standardsDir();
    assert.match(dir, /\/standards$/u);
    assert.equal(existsSync(dir), true);
});
