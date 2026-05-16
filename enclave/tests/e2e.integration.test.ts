/**
 * End-to-end integration test for the enclave CLI.
 *
 * Builds the binary, invokes it against a real Docker daemon with a
 * temporary HOME so we do not stomp on the developer's real config,
 * and asserts the round-trip behaviour for both an allow-rule config
 * and the default-deny path.
 *
 * Slow — guarded behind DOCKER_AVAILABLE.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

function isDockerAvailable(): boolean {
  try {
    execSync("docker info --format '{{.OSType}}'", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_AVAILABLE = isDockerAvailable();

describe.runIf(DOCKER_AVAILABLE)("enclave end-to-end", { timeout: 600_000 }, () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const enclaveRoot = resolve(here, "..");
  const binPath = resolve(enclaveRoot, "dist", "src", "index.js");

  let tmpHome: string;
  const testProxyImage = "enclave-proxy:test";

  beforeAll(() => {
    // Build the binary.
    execSync("npm run build", { cwd: enclaveRoot, stdio: "pipe" });

    // Build a local proxy image so we don't depend on a published
    // ghcr.io tag (a branch's package.json version often won't have a
    // matching published image). Skip the build if the test image
    // already exists.
    try {
      execSync(`docker image inspect ${testProxyImage} > /dev/null`, { stdio: "pipe" });
    } catch {
      execSync(`docker build -t ${testProxyImage} ../proxy`, { cwd: enclaveRoot, stdio: "pipe" });
    }

    // Isolated HOME so we read our test config, not the developer's.
    tmpHome = mkdtempSync(resolve(tmpdir(), "enclave-e2e-"));
    mkdirSync(resolve(tmpHome, ".config", "enclave"), { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function writeConfig(yaml: string) {
    writeFileSync(resolve(tmpHome, ".config", "enclave", "config.yaml"), yaml, "utf-8");
  }

  function runEnclave(args: string[]) {
    return spawnSync("node", [binPath, ...args], {
      env: {
        ...process.env,
        HOME: tmpHome,
        ENCLAVE_PROXY_IMAGE: testProxyImage,
      },
      cwd: enclaveRoot,
      encoding: "utf-8",
    });
  }

  it("rejects invocation without '--'", () => {
    writeConfig(`image: ubuntu:24.04\n`);
    const result = runEnclave(["echo", "hi"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("enclave -- <program>");
  });

  it("exits 2 with example config when config is missing", () => {
    rmSync(resolve(tmpHome, ".config", "enclave", "config.yaml"), { force: true });
    const result = runEnclave(["--", "echo", "hi"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("No config at");
    expect(result.stderr).toMatch(/image:.*\n/);
  });

  it("runs the inner program and propagates stdout and exit code (default-deny)", () => {
    writeConfig(`image: ubuntu:24.04\n`);
    const result = runEnclave(["--", "sh", "-c", "echo from-inside; exit 7"]);
    expect(result.status).toBe(7);
    expect(result.stdout).toContain("from-inside");
    expect(result.stderr).toContain("No networkPolicies in config");
  });

  it("default-deny blocks outbound HTTP", () => {
    writeConfig(`image: ubuntu:24.04\n`);
    const result = runEnclave([
      "--", "sh", "-c",
      "wget -q -O - --tries=1 --timeout=5 https://example.com >/dev/null 2>&1 && echo allowed || echo blocked",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("blocked");
  });
});
