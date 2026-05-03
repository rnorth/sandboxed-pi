/**
 * Tests for egress.ts — egress proxy lifecycle and policy parsing.
 *
 * Mocks docker.js to avoid needing a real Docker daemon for unit tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Mock docker.js
// ---------------------------------------------------------------------------

const mockDockerExecRaw = vi.fn();
const mockIsContainerRunning = vi.fn();

vi.mock("../src/docker.js", () => ({
  dockerExecRaw: (...args: unknown[]) => mockDockerExecRaw(...args),
  isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

const {
  parsePolicyFile,
  validatePolicy,
} = await import("../src/egress.js");

// ---------------------------------------------------------------------------
// Policy file helpers
// ---------------------------------------------------------------------------

const tmpDir = "/tmp/sandboxed-pi-test-policy";
const tmpPolicyPath = resolve(tmpDir, "policy.yaml");

function writePolicy(content: string) {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(tmpPolicyPath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parsePolicyFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a simple host with one rule", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: ALLOW
        path: /api/v.*/repos/.*
        method: GET
`);
    const policy = parsePolicyFile(tmpPolicyPath);

    expect(policy.file).toBe(tmpPolicyPath);
    expect(policy.networkPolicies).toHaveLength(1);
    expect(policy.networkPolicies[0].host).toBe("example.com");
    expect(policy.networkPolicies[0].policies).toHaveLength(1);
    expect(policy.networkPolicies[0].policies[0]).toEqual({
      action: "ALLOW",
      path: "/api/v.*/repos/.*",
      method: "GET",
    });
  });

  it("parses multiple hosts and rules", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: DENY
        path: /admin
        method: "*"
      - action: ALLOW
        path: /.*
        method: GET
  - host: api.github.com
    policies:
      - action: ALLOW
        path: /repos/.*
        method: GET
      - action: ALLOW
        path: /users/.*
        method: GET
`);
    const policy = parsePolicyFile(tmpPolicyPath);

    expect(policy.networkPolicies).toHaveLength(2);
    expect(policy.networkPolicies[0].host).toBe("example.com");
    expect(policy.networkPolicies[0].policies).toHaveLength(2);
    expect(policy.networkPolicies[1].host).toBe("api.github.com");
    expect(policy.networkPolicies[1].policies).toHaveLength(2);
  });

  it("ignores empty lines and comments", () => {
    writePolicy(`
      # This is a comment
networkPolicies:
  - host: example.com
    policies:
      - action: ALLOW
        path: /api/.*
        method: GET

  - host: api.example.com
    policies:
      - action: ALLOW
        path: /users/[^/]+/gists
        method: GET
    `);
    const policy = parsePolicyFile(tmpPolicyPath);

    expect(policy.networkPolicies).toHaveLength(2);
    expect(policy.networkPolicies[0].host).toBe("example.com");
    expect(policy.networkPolicies[1].host).toBe("api.example.com");
  });

  it("returns empty networkPolicies for file with only comments", () => {
    writePolicy(`# Just a comment\n# Another one`);
    const policy = parsePolicyFile(tmpPolicyPath);

    expect(policy.networkPolicies).toHaveLength(0);
  });

  it("skips invalid rule entries", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: ALLOW
        path: /api/.*
        method: GET
      - invalid: rule
      - action: DENY
        path: /secret
        method: GET
`);
    const policy = parsePolicyFile(tmpPolicyPath);

    expect(policy.networkPolicies).toHaveLength(1);
    expect(policy.networkPolicies[0].policies).toHaveLength(2);
  });

  it("skips rules with invalid action", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: MAYBE
        path: /api/.*
        method: GET
`);
    const policy = parsePolicyFile(tmpPolicyPath);

    // Invalid rules are skipped, leaving an empty policies array
    expect(policy.networkPolicies).toHaveLength(1);
    expect(policy.networkPolicies[0].policies).toHaveLength(0);
  });
});

describe("validatePolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns valid for a well-formed policy", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: ALLOW
        path: /api/v.*/repos/.*
        method: GET
  - host: api.github.com
    policies:
      - action: ALLOW
        path: /repos/.*
        method: GET
`);
    const result = validatePolicy(tmpPolicyPath);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns invalid when file does not exist", () => {
    const result = validatePolicy("/nonexistent/path/policy.yaml");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns invalid when file has no network policy entries", () => {
    writePolicy(`# Empty policy\n`);
    const result = validatePolicy(tmpPolicyPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("no network policy entries");
  });

  it("returns invalid when a host has no rules", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies: []
`);
    const result = validatePolicy(tmpPolicyPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("no policy rules");
  });

  it("returns invalid when a rule has an invalid action", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: MAYBE
        path: /api/.*
        method: GET
`);
    const result = validatePolicy(tmpPolicyPath);

    // Invalid action is silently skipped, resulting in empty rules
    expect(result.valid).toBe(false);
    expect(result.error).toContain("no policy rules");
  });

  it("returns invalid when a path is not a valid regex", () => {
    // (*.) is an unclosed group in JavaScript regex
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: DENY
        path: (*.)
        method: GET
`);
    const result = validatePolicy(tmpPolicyPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid regex pattern");
  });

  it("returns invalid when a rule is missing path", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: DENY
        method: GET
`);
    const result = validatePolicy(tmpPolicyPath);

    // Missing path is silently skipped, resulting in empty rules
    expect(result.valid).toBe(false);
    expect(result.error).toContain("no policy rules");
  });

  it("returns invalid when a rule is missing method", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: DENY
        path: /.*
`);
    const result = validatePolicy(tmpPolicyPath);

    // Missing method is silently skipped, resulting in empty rules
    expect(result.valid).toBe(false);
    expect(result.error).toContain("no policy rules");
  });

  it("validates method field values", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: DENY
        path: /.*
        method: GET
      - action: ALLOW
        path: /.*
        method: "*"
`);
    const result = validatePolicy(tmpPolicyPath);

    expect(result.valid).toBe(true);
  });
});
