// Tests for the OpenCollection rules: no-tests, the request secrets checks and
// the environment variable rule. Run: node --test runtime/lib/test-review/collection.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewTestSources } from "./rules.mts";

/** A request with a variable URL and no assertions, for rule-specific cases. */
function request(extra: readonly string[] = []): string {
    return [
        "info:",
        "  name: Get users",
        "  type: http",
        "http:",
        "  method: GET",
        "  url: {{baseUrl}}/users",
        ...extra,
    ].join("\n");
}

test("reports a request with neither assertions nor a tests script", () => {
    // Arrange
    const content = request();

    // Act
    const findings = reviewTestSources([
        { path: "requests/users.yml", content },
    ]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "no-tests", line: 1 }],
    );
    assert.match(findings[0]?.message ?? "", /Get users/u);
});

test("stays silent when the request declares assertions or a tests script", () => {
    // Arrange
    const contents = [
        request([
            "runtime:",
            "  assertions:",
            "    - expression: res.status",
            "      operator: eq",
            '      value: "200"',
        ]),
        request([
            "runtime:",
            "  scripts:",
            "    - type: tests",
            "      code: |",
            '        test("returns users", () => {',
            "          expect(res.body).to.have.length(2);",
            "        });",
        ]),
    ];

    // Act
    const found = contents.map((content) =>
        reviewTestSources([{ path: "requests/users.yml", content }]),
    );

    // Assert
    assert.deepEqual(
        found,
        contents.map(() => []),
    );
});

test("reports a blank tests script as no tests", () => {
    // Arrange
    const content = request(["runtime:", "  scripts:", "    - type: tests"]);

    // Act
    const findings = reviewTestSources([
        { path: "requests/users.yml", content },
    ]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => finding.rule),
        ["no-tests"],
    );
});

test("reports a literal scheme and host at the url line", () => {
    // Arrange
    const content = [
        "info:",
        "  name: Get users",
        "  type: http",
        "http:",
        "  method: GET",
        "  url: https://api.example.test/users",
        "runtime:",
        "  assertions:",
        "    - expression: res.status",
        '      value: "200"',
    ].join("\n");

    // Act
    const findings = reviewTestSources([
        { path: "requests/users.yml", content },
    ]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "hardcoded-host", line: 6 }],
    );
    assert.match(findings[0]?.message ?? "", /api\.example\.test/u);
});

test("stays silent when the url is a variable", () => {
    // Arrange
    const content = request([
        "runtime:",
        "  assertions:",
        "    - expression: res.status",
        '      value: "200"',
    ]);

    // Act
    const findings = reviewTestSources([
        { path: "requests/users.yml", content },
    ]);

    // Assert
    assert.deepEqual(findings, []);
});

test("reports a literal credential in the auth block and withholds it", () => {
    // Arrange
    const content = request([
        "  auth:",
        "    type: bearer",
        "    token: super-secret-value",
        "runtime:",
        "  assertions:",
        "    - expression: res.status",
        '      value: "200"',
    ]);

    // Act
    const findings = reviewTestSources([
        { path: "requests/users.yml", content },
    ]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "plaintext-credential", line: 9 }],
    );
    assert.doesNotMatch(findings[0]?.message ?? "", /super-secret-value/u);
});

test("stays silent when the credential is a variable", () => {
    // Arrange
    const content = request([
        "  auth:",
        "    type: bearer",
        '    token: "{{apiToken}}"',
        "runtime:",
        "  assertions:",
        "    - expression: res.status",
        '      value: "200"',
    ]);

    // Act
    const findings = reviewTestSources([
        { path: "requests/users.yml", content },
    ]);

    // Assert
    assert.deepEqual(findings, []);
});

test("does not read a token outside the auth block", () => {
    // Arrange
    const content = request([
        "  params:",
        "    token: abc123",
        "runtime:",
        "  assertions:",
        "    - expression: res.status",
        '      value: "200"',
    ]);

    // Act
    const findings = reviewTestSources([
        { path: "requests/users.yml", content },
    ]);

    // Assert
    assert.deepEqual(findings, []);
});

test("reports a credential-named variable with a literal value", () => {
    // Arrange
    const content = [
        "variables:",
        "  - name: apiToken",
        "    value: abc123",
        "    secret: false",
    ].join("\n");

    // Act
    const findings = reviewTestSources([
        { path: "environments/local.yml", content },
    ]);

    // Assert
    assert.deepEqual(
        findings.map((finding) => ({
            rule: finding.rule,
            line: finding.line,
        })),
        [{ rule: "unlabelled-secret-var", line: 2 }],
    );
    assert.match(findings[0]?.message ?? "", /apiToken/u);
});

test("stays silent for a secret or a variable-reference value", () => {
    // Arrange
    const contents = [
        [
            "variables:",
            "  - name: apiToken",
            "    value: abc123",
            "    secret: true",
        ].join("\n"),
        ["variables:", "  - name: apiToken", '    value: "{{apiToken}}"'].join(
            "\n",
        ),
        ["variables:", "  - name: apiToken", "    value: "].join("\n"),
    ];

    // Act
    const found = contents.map((content) =>
        reviewTestSources([{ path: "environments/local.yml", content }]),
    );

    // Assert
    assert.deepEqual(
        found,
        contents.map(() => []),
    );
});

test("does not apply the environment rule outside an environments path", () => {
    // Arrange
    const content = [
        "variables:",
        "  - name: apiToken",
        "    value: abc123",
    ].join("\n");

    // Act
    const findings = reviewTestSources([
        { path: "requests/local.yml", content },
    ]);

    // Assert
    assert.deepEqual(findings, []);
});

test("does not treat ordinary YAML as a request", () => {
    // Arrange
    const content = ["info:", "  title: Workflow", "ports:", "  - 8080"].join(
        "\n",
    );

    // Act
    const findings = reviewTestSources([{ path: "workflow.yml", content }]);

    // Assert
    assert.deepEqual(findings, []);
});

test("does not treat an author name as a credential", () => {
    // Arrange
    const contents = [
        ["variables:", "  - name: authorName", "    value: Mark"].join("\n"),
        ["variables:", "  - name: authToken", "    value: abc123"].join("\n"),
        [
            "variables:",
            "  - name: authorization",
            "    value: Bearer abc123",
        ].join("\n"),
    ];

    // Act
    const found = contents.map((content) =>
        reviewTestSources([{ path: "environments/local.yml", content }]),
    );

    // Assert
    assert.deepEqual(
        found.map((findings) => findings.map((finding) => finding.rule)),
        [[], ["unlabelled-secret-var"], ["unlabelled-secret-var"]],
    );
});

test("stays silent when only the scheme is literal", () => {
    // Arrange
    const content = [
        "info:",
        "  name: Get users",
        "  type: http",
        "http:",
        "  method: GET",
        "  url: https://{{host}}/users",
        "runtime:",
        "  assertions:",
        "    - expression: res.status",
        '      value: "200"',
    ].join("\n");

    // Act
    const findings = reviewTestSources([
        { path: "requests/users.yml", content },
    ]);

    // Assert
    assert.deepEqual(findings, []);
});
