/**
 * Integration tests for docker.ts — runs against real Docker.
 *
 * These tests create and destroy actual containers, so they need a
 * running Docker daemon. Automatically skipped if Docker is unavailable.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const { execInContainer, isContainerRunning, destroySandboxContainer, createSandboxContainer } =
  await import("../src/docker.js");

const { createProxyContainer, destroyProxyContainer } =
  await import("../src/egress.js");

// ---------------------------------------------------------------------------
// Docker availability check
// ---------------------------------------------------------------------------

function isDockerAvailable(): boolean {
  try {
    execSync("docker info --format '{{.OSType}}'", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_AVAILABLE = isDockerAvailable();

// ---------------------------------------------------------------------------
// execInContainer
// ---------------------------------------------------------------------------

describe.runIf(DOCKER_AVAILABLE)("execInContainer", () => {
  // Use a real alpine container for these tests
  const containerName = `test-execincontainer-${Date.now()}`;

  beforeAll(() => {
    execSync(
      `docker run -d --rm --name ${containerName} alpine:3.20 sleep 3600`,
      { stdio: "pipe" },
    );
  });

  afterAll(() => {
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: "pipe" });
    } catch {
      // already gone
    }
  });

  it("executes a command and returns stdout", async () => {
    const result = await execInContainer(containerName, ["echo", "hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("hello");
  });

  it("captures stderr separately", async () => {
    const result = await execInContainer(containerName, [
      "sh", "-c", "echo error >&2",
    ]);
    expect(result.exitCode).toBe(0);
    // stdout should be empty (only stderr gets the message)
    expect(result.stdout.toString().trim()).toBe("");
    expect(result.stderr.toString().trim()).toBe("error");
  });

  it("returns non-zero exit code on command failure", async () => {
    const result = await execInContainer(containerName, [
      "sh", "-c", "exit 42",
    ]);
    expect(result.exitCode).toBe(42);
  });

  it("streams stdout via onData callback", async () => {
    const chunks: Buffer[] = [];
    const result = await execInContainer(
      containerName,
      ["sh", "-c", "echo line1; echo line2"],
      { onData: (chunk) => chunks.push(chunk) },
    );
    expect(result.exitCode).toBe(0);
    expect(chunks.length).toBeGreaterThan(0);
    expect(Buffer.concat(chunks).toString()).toContain("line1");
  });

  it("sets working directory with -w option", async () => {
    const result = await execInContainer(
      containerName,
      ["sh", "-c", "pwd"],
      { cwd: "/tmp" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("/tmp");
  });

  it("writes stdin content to the container process", async () => {
    const result = await execInContainer(
      containerName,
      ["cat"],
      { stdin: "stdin content" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("stdin content");
  });

  it("rejects on timeout", async () => {
    // Note: Alpine's `sleep` is a shell builtin or /bin/sleep
    await expect(
      execInContainer(containerName, ["sleep", "10"], { timeout: 1 }),
    ).rejects.toThrow("timeout:1");
  });
});

// ---------------------------------------------------------------------------
// isContainerRunning
// ---------------------------------------------------------------------------

describe.runIf(DOCKER_AVAILABLE)("isContainerRunning", () => {
  it("returns true for a running container", async () => {
    const name = `test-ctr-${Date.now()}`;
    execSync(`docker run -d --rm --name ${name} alpine:3.20 sleep 60`, { stdio: "pipe" });
    try {
      expect(await isContainerRunning(name)).toBe(true);
    } finally {
      execSync(`docker rm -f ${name}`, { stdio: "pipe" });
    }
  });

  it("returns false for a non-existent container", async () => {
    expect(await isContainerRunning(`nonexistent-${Date.now()}-xyz`)).toBe(false);
  });

  it("returns false for a stopped (created but not started) container", async () => {
    const name = `test-ctr-${Date.now()}`;
    execSync(`docker create --name ${name} alpine:3.20 sleep 60`, { stdio: "pipe" });
    try {
      expect(await isContainerRunning(name)).toBe(false);
    } finally {
      execSync(`docker rm -f ${name}`, { stdio: "pipe" });
    }
  });
});

// ---------------------------------------------------------------------------
// destroySandboxContainer
// ---------------------------------------------------------------------------

describe.runIf(DOCKER_AVAILABLE)("destroySandboxContainer", () => {
  it("stops and removes a running container", async () => {
    const name = `test-ctr-${Date.now()}`;
    execSync(`docker run -d --name ${name} alpine:3.20 sleep 60`, { stdio: "pipe" });

    await destroySandboxContainer(name);

    // Verify container is gone
    expect(() =>
      execSync(`docker inspect ${name}`, { stdio: "pipe" }),
    ).toThrow();
  });

  it("does not throw when container is already gone", async () => {
    await expect(
      destroySandboxContainer(`nonexistent-${Date.now()}`),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createSandboxContainer
// ---------------------------------------------------------------------------

describe.runIf(DOCKER_AVAILABLE)("createSandboxContainer", () => {
  const testImage = "alpine:3.20";
  const testCwd = process.cwd();

  it("pulls the image and creates a running container", async () => {
    const name = `test-ctr-${Date.now()}`;
    const containerName = await createSandboxContainer(
      testImage,
      testCwd,
      name,
    );

    expect(containerName).toBe(name);
    expect(await isContainerRunning(name)).toBe(true);

    await destroySandboxContainer(name);
  });

  it("generates a name when not provided", async () => {
    const containerName = await createSandboxContainer(
      testImage,
      testCwd,
    );

    expect(containerName).toMatch(/^enclave-sandbox-/);

    await destroySandboxContainer(containerName);
  });

  it("mounts the working directory at the same path inside the container", async () => {
    const name = `test-ctr-${Date.now()}`;
    await createSandboxContainer(testImage, testCwd, name);

    try {
      const result = await execInContainer(name, ["test", "-d", testCwd]);
      expect(result.exitCode).toBe(0);
    } finally {
      await destroySandboxContainer(name);
    }
  });

  it("makes the working directory read-writable inside the container", async () => {
    const name = `test-ctr-${Date.now()}`;
    await createSandboxContainer(testImage, testCwd, name);

    try {
      // Use sh instead of bash (alpine doesn't have bash)
      const result = await execInContainer(
        name,
        ["sh", "-c", `printf "test-write" > ${testCwd}/.docker-test-write && cat ${testCwd}/.docker-test-write`],
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe("test-write");
    } finally {
      try {
        execSync(`rm ${testCwd}/.docker-test-write`, { stdio: "pipe" });
      } catch {
        // ignore
      }
      await destroySandboxContainer(name);
    }
  });
});

// ---------------------------------------------------------------------------
// egress proxy – DNS interception
// ---------------------------------------------------------------------------

// Policy that allows one.one.one.one (Cloudflare's DoH endpoint)
const DNS_TEST_POLICY = `
networkPolicies:
  - host: one.one.one.one
    policies:
      - action: ALLOW
        path: /.*
        method: GET
`;

describe.runIf(DOCKER_AVAILABLE)("egress proxy – DNS interception", { timeout: 300_000 }, () => {
  // Proxy setup (CA cert generation) can take up to ~3 minutes on cold start
  const workloadImage = "ghcr.io/catthehacker/ubuntu:act-latest";
  const suffix = Date.now();
  const workloadName = `test-dns-workload-${suffix}`;
  const policyDir = `/tmp/sandboxed-pi-dns-test-${suffix}`;
  const policyPath = resolve(policyDir, "policy.yaml");

  beforeAll(async () => {
    // Write policy file
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(policyPath, DNS_TEST_POLICY, "utf-8");

    // Start workload container (detached, no network yet — proxy will share its netns)
    execSync(
      `docker run -d --rm --name ${workloadName} ${workloadImage} sleep 3600`,
      { stdio: "pipe" },
    );

    // Build the proxy image locally so we don't depend on ghcr.io for tests.
    // Skip if the test image already exists to avoid rebuilding on every run.
    const testProxyImage = "pi-egress-proxy:test";
    try {
      execSync(`docker image inspect ${testProxyImage} > /dev/null`, { stdio: "pipe" });
    } catch {
      execSync(
        `docker build -t ${testProxyImage} ../proxy`,
        { stdio: "pipe" },
      );
    }

    // Start proxy sidecar (shares workload netns, installs CA cert in workload)
    await createProxyContainer(policyPath, workloadName, testProxyImage);
  }, 300_000);

  afterAll(async () => {
    // destroyProxyContainer is best-effort; the proxy may already be gone
    try {
      execSync(`docker ps -q --filter name=pi-egress-proxy`, { stdio: "pipe" })
        .toString().trim()
        .split("\n")
        .filter(Boolean)
        .forEach((id) => execSync(`docker rm -f ${id}`, { stdio: "pipe" }));
    } catch {
      // ignore
    }
    try {
      execSync(`docker rm -f ${workloadName}`, { stdio: "pipe" });
    } catch {
      // already gone
    }
  });

  // All workload commands run as non-root (uid 1000) so the iptables rules
  // intercept their traffic.  The proxy exempts root-owned packets from
  // redirection so that its own upstream connections are not looped.
  const nonRoot = { asUser: "1000:1000" };

  it("resolves policy-listed hostname", async () => {
    // Use Python's socket module — dig/nslookup may not be installed in all images
    const result = await execInContainer(workloadName, [
      "python3", "-c",
      "import socket; print(socket.gethostbyname('one.one.one.one'))",
    ], nonRoot);
    const output = result.stdout.toString().trim();
    expect(output).toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("non-policy hostname returns resolution failure", async () => {
    // The DNS interceptor returns NXDOMAIN; Python raises socket.gaierror
    const result = await execInContainer(workloadName, [
      "python3", "-c",
      "import socket; socket.gethostbyname('random-not-in-policy.example.com')",
    ], nonRoot);
    // Expect non-zero exit (gaierror raised, no output printed)
    expect(result.exitCode).not.toBe(0);
  });

  it("direct-to-IP with wrong hostname is denied (403 or connection failure)", async () => {
    // Connect to 9.9.9.9 (Quad9) while claiming to be one.one.one.one via SNI.
    // 9.9.9.9 was never recorded in BindingCache for one.one.one.one, so the
    // binding check in the proxy should return 403.
    const result = await execInContainer(workloadName, [
      "curl", "-sk", "-o", "/dev/null", "-w", "%{http_code}",
      "--connect-to", "one.one.one.one:443:9.9.9.9:443",
      "https://one.one.one.one/",
    ], nonRoot);
    const statusCode = result.stdout.toString().trim();
    const denied = result.exitCode !== 0 || statusCode === "403" || statusCode === "000";
    expect(denied).toBe(true);
  });

  it("legitimate DNS + HTTP GET succeeds (200)", async () => {
    // Accept header required by Cloudflare's DoH endpoint for JSON responses
    const result = await execInContainer(workloadName, [
      "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
      "-H", "Accept: application/dns-json",
      "https://one.one.one.one/dns-query?name=example.com&type=A",
    ], nonRoot);
    const statusCode = result.stdout.toString().trim();
    expect(statusCode).toBe("200");
  });
});
