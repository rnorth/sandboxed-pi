/**
 * Integration tests for docker.ts — runs against real Docker.
 *
 * These tests create and destroy actual containers, so they need a
 * running Docker daemon. Automatically skipped if Docker is unavailable.
 */

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";

const { execInContainer, isContainerRunning, destroySandboxContainer, createSandboxContainer } =
  await import("../src/docker.js");

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

    expect(containerName).toMatch(/^pi-sandboxed-/);

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
