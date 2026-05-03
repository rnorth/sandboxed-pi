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

  it("parses a simple host with one pattern", () => {
    writePolicy(`example.com: /api/v.*/repos/.*`);
    const policy = parsePolicyFile(tmpPolicyPath);

    expect(policy.file).toBe(tmpPolicyPath);
    expect(Object.keys(policy.allowlist)).toContain("example.com");
    expect(policy.allowlist["example.com"]).toHaveLength(1);
  });

  it("parses multiple hosts and patterns", () => {
    writePolicy(
      "example.com: /api/v.*/repos/.*\n" +
      "api.github.com: /repos/.*, /user",
    );
    const policy = parsePolicyFile(tmpPolicyPath);


    expect(Object.keys(policy.allowlist)).toEqual(["example.com", "api.github.com"]);
    expect(policy.allowlist["example.com"]).toHaveLength(1);
    expect(policy.allowlist["api.github.com"]).toHaveLength(2);
  });

  it("ignores empty lines and comments", () => {
    writePolicy(`
      # This is a comment
      example.com: /api/.*

      # Another comment
      api.example.com: /users/[^/]+/gists
    `);
    const policy = parsePolicyFile(tmpPolicyPath);

    expect(Object.keys(policy.allowlist)).toHaveLength(2);
    expect(policy.allowlist["example.com"]).toHaveLength(1);
    expect(policy.allowlist["api.example.com"]).toHaveLength(1);
  });

  it("strips quotes from patterns", () => {
    writePolicy(`example.com: "/api/v.*", '/users/.*'`);
    const policy = parsePolicyFile(tmpPolicyPath);

    expect(policy.allowlist["example.com"]).toContain("/api/v.*");
    expect(policy.allowlist["example.com"]).toContain("/users/.*");
  });

  it("skips lines without a colon", () => {
    writePolicy(`
      example.com: /api/.*
      not a valid line no colon here
      api.example.com: /users/.*
    `);
    const policy = parsePolicyFile(tmpPolicyPath);

    expect(Object.keys(policy.allowlist)).toHaveLength(2);
  });

  it("returns empty allowlist for file with only comments", () => {
    writePolicy(`# Just a comment\n# Another one`);
    const policy = parsePolicyFile(tmpPolicyPath);

    expect(Object.keys(policy.allowlist)).toHaveLength(0);
  });
});

describe("validatePolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns valid for a well-formed policy", () => {
    writePolicy(`example.com: /api/v.*/repos/.*\napi.github.com: /repos/.*`);
    const result = validatePolicy(tmpPolicyPath);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns invalid when file does not exist", () => {
    const result = validatePolicy("/nonexistent/path/policy.yaml");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns invalid when file has no allowlist entries", () => {
    writePolicy(`# Empty policy\n`);
    const result = validatePolicy(tmpPolicyPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("no allowlist entries");
  });

  it("returns invalid when a host has no patterns", () => {
    writePolicy(`example.com:\ngithub.com: /repos/.*`);
    const result = validatePolicy(tmpPolicyPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("no allowed patterns");
  });

  it("returns invalid when a pattern is not a valid regex", () => {
    // (*.) is an unclosed group in JavaScript regex
    writePolicy(`example.com: (*.)`);
    const result = validatePolicy(tmpPolicyPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid regex pattern");
  });
});
