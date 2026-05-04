/**
 * Tests for egress.ts — egress proxy lifecycle and policy validation.
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

describe("validatePolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns valid for an existing policy file", () => {
    writePolicy(`
networkPolicies:
  - host: example.com
    policies:
      - action: ALLOW
        path: /api/v.*/repos/.*
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
});
