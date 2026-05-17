/**
 * Integration tests for image.ts — runs against real Docker.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { buildEnclaveImage, ensureEnclaveBaseImage, getHostUser, ENCLAVE_BASE_IMAGE_TAG } from "../src/image.js";

function isDockerAvailable(): boolean {
  try {
    execSync("docker info --format '{{.OSType}}'", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_AVAILABLE = isDockerAvailable();

describe.runIf(DOCKER_AVAILABLE)("buildEnclaveImage", { timeout: 600_000 }, () => {
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

  it("ensureEnclaveBaseImage builds enclave-base:latest when missing", async () => {
    // Force-clean the curated image so the test exercises the build path.
    try {
      execSync(`docker image rm -f enclave-base:latest`, { stdio: "pipe" });
    } catch {
      // ignore — may not exist
    }
    await ensureEnclaveBaseImage();
    expect(() =>
      execSync(`docker image inspect enclave-base:latest`, { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("ensureEnclaveBaseImage is a no-op when the image already exists", async () => {
    // The previous test left it present.
    const before = execSync(`docker image inspect -f '{{.Id}}' enclave-base:latest`, { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    await ensureEnclaveBaseImage();
    const after = execSync(`docker image inspect -f '{{.Id}}' enclave-base:latest`, { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    expect(after).toBe(before);
  });

  it("buildEnclaveImage without explicit baseImage builds using the curated base", async () => {
    const built = await buildEnclaveImage();
    expect(built).toBe(expectedImage);
    // The curated base should be present as a side-effect
    expect(() =>
      execSync(`docker image inspect ${ENCLAVE_BASE_IMAGE_TAG}`, { stdio: "pipe" }),
    ).not.toThrow();
  });
});
