/**
 * Per-user sandbox image build.
 *
 * Builds a derivative of the user-supplied base image with the host
 * user's UID/GID/name baked in, so files created inside the container
 * are owned by the host user. The result is cached as
 * `enclave-<user>:<uid>`; rebuilds are cheap once Docker has the layers.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerExecRaw } from "./docker.js";

export interface HostUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

export function getHostUser(): HostUser {
  const name = process.env.USER ?? process.env.USERNAME ?? "root";
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const home = process.env.HOME ?? "/root";
  return { name, uid, gid, home };
}

/**
 * Locate Dockerfile.template at the enclave/ root, regardless of whether
 * we are running from src/ (via vitest/tsx) or dist/src/ (compiled bin).
 */
function locateDockerfileTemplate(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../Dockerfile.template", "../../Dockerfile.template"]) {
    const candidate = resolve(here, rel);
    try {
      readFileSync(candidate, "utf-8");
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error("Could not locate Dockerfile.template alongside enclave/");
}

/**
 * Build (or rebuild) the per-user sandbox image and return its name.
 */
export async function buildEnclaveImage(baseImage: string): Promise<string> {
  const hostUser = getHostUser();
  const imageName = `enclave-${hostUser.name}:${hostUser.uid}`;

  const templatePath = locateDockerfileTemplate();
  const dockerfile = readFileSync(templatePath, "utf-8");
  const contextDir = dirname(templatePath);

  await dockerExecRaw([
    "build",
    "--build-arg", `BASE_IMAGE=${baseImage}`,
    "--build-arg", `USER_NAME=${hostUser.name}`,
    "--build-arg", `USER_UID=${hostUser.uid}`,
    "--build-arg", `USER_GID=${hostUser.gid}`,
    "-t", imageName,
    "-f", "-",
    contextDir,
  ], dockerfile);

  return imageName;
}
