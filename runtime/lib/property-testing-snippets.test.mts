// Guards the compiled C# shapes in standards/testing/property-testing.md:
// every `<!-- snippet: name -->` block must appear verbatim in its fixture, so
// an FsCheck/xUnit API drift is a red build rather than stale prose.
// Run: node --test runtime/lib/property-testing-snippets.test.mts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { reviewTestSources } from "./test-review/rules.mts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const PAGE = join(REPO_ROOT, "standards", "testing", "property-testing.md");
const FIXTURES = join(REPO_ROOT, "docs", "fixtures", "property-testing");

/** The fixture that compiles each marked snippet. */
const FIXTURE_BY_SNIPPET: Readonly<Record<string, string>> = {
    "domain-type": "CustomerXml.cs",
    law: "CustomerXmlPropertyTests.cs",
    "round-trips": "CustomerXmlPropertyTests.cs",
    generator: "CustomerArbitraries.cs",
    "seed-ledger": "CustomerXmlSeeds.cs",
    canary: "CustomerXmlPropertyTests.cs",
    "replay-theory": "CustomerXmlPropertyTests.cs",
    "promoted-example": "CustomerXmlTests.cs",
};

const MARKER = /^<!-- snippet: (?<name>[a-z0-9-]+) -->$/u;
const FENCE_OPEN = /^```csharp$/u;
const FENCE_CLOSE = /^```$/u;

/**
 * Extract each marked snippet's fenced C# body, keyed by marker name.
 *
 * @param doc The markdown page carrying the markers.
 * @returns Name → block text, without the fences or a trailing newline.
 * @throws When a marker is declared twice, or has no `csharp` fence in its own
 *   region before the next marker.
 */
function snippetsFrom(doc: string): Map<string, string> {
    const lines = doc.split("\n");
    const snippets = new Map<string, string>();
    for (let index = 0; index < lines.length; index += 1) {
        const marker = MARKER.exec(lines[index] ?? "");
        if (marker === null) {
            continue;
        }
        const name = marker.groups?.["name"] ?? "";
        if (snippets.has(name)) {
            throw new Error(`snippet "${name}" is declared more than once`);
        }
        const nextMarker = lines.findIndex(
            (line, candidate) => candidate > index && MARKER.test(line),
        );
        const regionEnd = nextMarker === -1 ? lines.length : nextMarker;
        const open = lines.findIndex(
            (line, candidate) =>
                candidate > index &&
                candidate < regionEnd &&
                FENCE_OPEN.test(line),
        );
        if (open === -1) {
            throw new Error(`snippet "${name}" has no csharp fence`);
        }
        const close = lines.findIndex(
            (line, candidate) =>
                candidate > open &&
                candidate < regionEnd &&
                FENCE_CLOSE.test(line),
        );
        if (close === -1) {
            throw new Error(`snippet "${name}" has an unterminated fence`);
        }
        snippets.set(name, lines.slice(open + 1, close).join("\n"));
    }
    return snippets;
}

/**
 * Report every marked snippet that is unknown or absent from its fixture.
 *
 * @param root0 The page and the fixture reader to check.
 * @param root0.doc The markdown page text.
 * @param root0.fixtureContent Reads a fixture file name to its text.
 * @returns One message per drift; empty when every snippet matches.
 */
function findDrift({
    doc,
    fixtureContent,
}: {
    doc: string;
    fixtureContent: (fileName: string) => string;
}): string[] {
    const drift: string[] = [];
    for (const [name, block] of snippetsFrom(doc)) {
        const fileName = FIXTURE_BY_SNIPPET[name];
        if (fileName === undefined) {
            drift.push(`snippet "${name}" has no fixture registered`);
            continue;
        }
        if (block.length === 0) {
            drift.push(`snippet "${name}" is empty`);
            continue;
        }
        if (!fixtureContent(fileName).includes(block)) {
            drift.push(
                `snippet "${name}" does not appear verbatim in ${fileName}`,
            );
        }
    }
    return drift;
}

/** Read a fixture beside the page under test. */
function fixtureContent(fileName: string): string {
    return readFileSync(join(FIXTURES, fileName), "utf8");
}

test("propertyTestingSnippets_markedBlocks_areContainedInTheirFixtures", () => {
    // Arrange
    const doc = readFileSync(PAGE, "utf8");

    // Act
    const drift = findDrift({ doc, fixtureContent });

    // Assert
    assert.deepEqual(drift, []);
});

test("propertyTestingSnippets_everyRegisteredMarker_hasABlock", () => {
    // Arrange
    const doc = readFileSync(PAGE, "utf8");

    // Act
    const names = [...snippetsFrom(doc).keys()];

    // Assert
    assert.deepEqual(names.sort(), Object.keys(FIXTURE_BY_SNIPPET).sort());
});

test("propertyTestingSnippets_mutatedBlock_isReportedAsDrift", () => {
    // Arrange
    const doc = [
        "<!-- snippet: law -->",
        "```csharp",
        "public void RenderThenParse_RestoresOriginal(Customer original)",
        "```",
    ].join("\n");
    const fixtureContent = () =>
        "public void RenderThenParse_RestoresChanged(Customer original)";

    // Act
    const drift = findDrift({ doc, fixtureContent });

    // Assert
    assert.deepEqual(drift, [
        'snippet "law" does not appear verbatim in CustomerXmlPropertyTests.cs',
    ]);
});

test("propertyTestingSnippets_duplicateMarker_isReported", () => {
    // Arrange
    const doc = [
        "<!-- snippet: law -->",
        "```csharp",
        "one();",
        "```",
        "",
        "<!-- snippet: law -->",
        "```csharp",
        "two();",
        "```",
    ].join("\n");

    // Act / Assert
    assert.throws(() => snippetsFrom(doc), /"law" is declared more than once/u);
});

test("propertyTestingSnippets_markerWithoutCsharpFence_doesNotBorrowTheNextBlock", () => {
    // Arrange — the first marker's fence is tagged `cs`, not `csharp`.
    const doc = [
        "<!-- snippet: law -->",
        "```cs",
        "one();",
        "```",
        "",
        "<!-- snippet: round-trips -->",
        "```csharp",
        "two();",
        "```",
    ].join("\n");

    // Act / Assert
    assert.throws(() => snippetsFrom(doc), /"law" has no csharp fence/u);
});

test("propertyTestingFixtures_whenReviewed_reportNoFindings", () => {
    // Arrange
    const sources = readdirSync(FIXTURES)
        .filter((file) => file.endsWith(".cs"))
        .map((file) => ({
            path: `docs/fixtures/property-testing/${file}`,
            content: fixtureContent(file),
        }));

    // Act
    const findings = reviewTestSources(sources, { review: true });

    // Assert
    assert.deepEqual(findings, []);
});
