/**
 * Integration tests for image.ts — runs against real Docker.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { buildEnclaveImage, getHostUser } from "../src/image.js";

function isDockerAvailable(): boolean {
  try {
    execSync("docker info --format '{{.OSType}}'", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_AVAILABLE = isDockerAvailable();

describe.runIf(DOCKER_AVAILABLE)("buildEnclaveImage", { timeout: 300_000 }, () => {
  const user = getHostUser();
  const expectedImage = `enclave-${user.name}:${user.uid}`;

  afterAll(() => {
    // best-effort cleanup; the cache is fine to keep across runs but
    // we leave the test deterministic by removing whatever we built.
    try {
      execSync(`docker image rm -f ${expectedImage}`, { stdio: "pipe" });
    } catch {
      // ignore
    }
  });

  it("builds an image named enclave-<user>:<uid>", async () => {
    const built = await buildEnclaveImage("ubuntu:24.04");
    expect(built).toBe(expectedImage);
    expect(() =>
      execSync(`docker image inspect ${built}`, { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("bakes in a user with the host UID/GID", async () => {
    const built = await buildEnclaveImage("ubuntu:24.04");
    const out = execSync(
      `docker run --rm ${built} id -u`,
      { stdio: ["pipe", "pipe", "pipe"] },
    ).toString().trim();
    expect(out).toBe(String(user.uid));
  });
});
