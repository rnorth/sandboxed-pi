/**
 * Per-user sandbox image build.
 *
 * Two-stage:
 *   1. ensureEnclaveBaseImage() — builds the curated `enclave-base:latest`
 *      image from Dockerfile.base if it isn't already cached.
 *   2. buildEnclaveImage(baseImage?) — builds the per-user image
 *      (Dockerfile.template) on top of either the curated base
 *      (when no override is supplied) or a user-specified image.
 *
 * The result of buildEnclaveImage is cached as `enclave-<user>:<uid>`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerExecRaw } from "./docker.js";

export const ENCLAVE_BASE_IMAGE_TAG = "enclave-base:latest";

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
 * Locate a Dockerfile (Dockerfile.template or Dockerfile.base) at the
 * enclave/ root, regardless of whether we are running from src/ (via
 * vitest/tsx) or dist/src/ (compiled bin).
 */
function locateDockerfile(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of [`../${name}`, `../../${name}`]) {
    const candidate = resolve(here, rel);
    try {
      readFileSync(candidate, "utf-8");
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(`Could not locate ${name} alongside enclave/`);
}

/** True iff a local Docker image tag exists. */
async function dockerImageExists(tag: string): Promise<boolean> {
  try {
    await dockerExecRaw(["image", "inspect", tag]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the curated base image (`enclave-base:latest`) from
 * Dockerfile.base if it isn't already cached locally.
 */
export async function ensureEnclaveBaseImage(): Promise<string> {
  if (await dockerImageExists(ENCLAVE_BASE_IMAGE_TAG)) {
    return ENCLAVE_BASE_IMAGE_TAG;
  }

  console.error(
    `[enclave] Building curated base image ${ENCLAVE_BASE_IMAGE_TAG} (one-time, ~3 min)…`,
  );

  const dockerfilePath = locateDockerfile("Dockerfile.base");
  const dockerfile = readFileSync(dockerfilePath, "utf-8");
  const contextDir = dirname(dockerfilePath);

  await dockerExecRaw(
    [
      "build",
      "-t", ENCLAVE_BASE_IMAGE_TAG,
      "-f", "-",
      contextDir,
    ],
    dockerfile,
  );

  return ENCLAVE_BASE_IMAGE_TAG;
}

/**
 * Build (or rebuild) the per-user sandbox image and return its name.
 *
 * If `baseImage` is undefined, the curated `enclave-base:latest` is
 * built (if missing) and used as the base. If `baseImage` is supplied,
 * it is used verbatim and the curated build is skipped.
 */
export async function buildEnclaveImage(baseImage?: string): Promise<string> {
  const resolvedBase = baseImage ?? (await ensureEnclaveBaseImage());

  const hostUser = getHostUser();
  const imageName = `enclave-${hostUser.name}:${hostUser.uid}`;

  const templatePath = locateDockerfile("Dockerfile.template");
  const dockerfile = readFileSync(templatePath, "utf-8");
  const contextDir = dirname(templatePath);

  await dockerExecRaw([
    "build",
    "--build-arg", `BASE_IMAGE=${resolvedBase}`,
    "--build-arg", `USER_NAME=${hostUser.name}`,
    "--build-arg", `USER_UID=${hostUser.uid}`,
    "--build-arg", `USER_GID=${hostUser.gid}`,
    "-t", imageName,
    "-f", "-",
    contextDir,
  ], dockerfile);

  return imageName;
}
