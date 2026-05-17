/**
 * Low-level Docker helpers: container lifecycle and docker exec.
 *
 * Per-user image building has moved to image.ts. Callers of
 * createSandboxContainer are responsible for supplying a pre-built
 * image (typically via image.ts:buildEnclaveImage).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

/**
 * Create and start a sandbox container.
 * Mounts cwd at the same absolute path inside the container.
 * The caller is responsible for supplying a pre-built image (e.g. via
 * image.ts:buildEnclaveImage) that contains a user matching the host UID/GID.
 */
export async function createSandboxContainer(
  image: string,
  cwd: string,
  containerName?: string,
): Promise<string> {
  const name = containerName ?? `enclave-sandbox-${randomUUID().slice(0, 8)}`;

  const dockerArgs = [
    "run",
    "-d",
    "--rm",
    "--name", name,
    "-v", cwd + ":" + cwd + ":rw",
    image,
    "sleep", "infinity",
  ];

  await dockerExecRaw(dockerArgs);
  await waitForContainerRunning(name, 10_000);
  return name;
}

/**
 * Stop and remove a sandbox container.
 */
export async function destroySandboxContainer(name: string): Promise<void> {
  try {
    await dockerExecRaw(["rm", "-f", name]);
  } catch {
    // Container might already be gone
  }
}

/**
 * Check if a container exists and is running.
 */
export async function isContainerRunning(name: string): Promise<boolean> {
  try {
    const result = await dockerExecRaw(["inspect", "-f", "{{.State.Running}}", name]);
    return result.toString().trim() === "true";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Container exec
// ---------------------------------------------------------------------------

/**
 * Execute a command inside the container via docker exec.
 * Returns a promise that resolves with the exit code and captured output buffers.
 */
export function execInContainer(
  containerName: string,
  command: string[],
  options?: {
    /** Working directory inside container */
    cwd?: string;
    /** Stream output chunks via callback (for bash streaming) */
    onData?: (chunk: Buffer) => void;
    /** Abort signal */
    signal?: AbortSignal;
    /** Timeout in seconds */
    timeout?: number;
    /** Whether to allow stdin for writing files */
    stdin?: string;
    /** Run as a specific user (name or uid:gid) */
    asUser?: string;
  },
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const args = ["exec"];

    // Pass --user if specified, so we can run as root for setup tasks if needed
    if (options?.asUser) {
      args.push("--user", options.asUser);
    } else {
      args.push("-i");
    }

    if (options?.cwd) {
      args.push("-w", options.cwd);
    }

    args.push(containerName, ...command);

    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (options?.timeout) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeout * 1000);
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdoutChunks.push(data);
      options?.onData?.(data);
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderrChunks.push(data);
      options?.onData?.(data);
    });

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });

    const onAbort = () => child.kill();
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options?.signal?.removeEventListener("abort", onAbort);

      if (options?.signal?.aborted) {
        reject(new Error("aborted"));
      } else if (timedOut) {
        reject(new Error(`timeout:${options?.timeout}`));
      } else {
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
        });
      }
    });

    // Write stdin if provided
    if (options?.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Execute a docker command and return stdout as a trimmed string.
 * Throws on non-zero exit.
 */
export async function dockerExecRaw(args: string[], stdin?: string | Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (data: Buffer) => stdoutChunks.push(data));
    child.stderr?.on("data", (data: Buffer) => stderrChunks.push(data));

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        const errMsg = Buffer.concat(stderrChunks).toString().trim();
        reject(new Error(`docker ${args[0]} failed (${code}): ${errMsg}`));
      } else {
        resolve(Buffer.concat(stdoutChunks));
      }
    });

    // Write stdin content if provided (e.g., for docker build)
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }
  });
}

async function waitForContainerRunning(name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await isContainerRunning(name);
    if (running) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Container ${name} did not start within ${timeoutMs}ms`);
}