/**
 * Low-level Docker helpers: container lifecycle and docker exec
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * Create and start a sandbox container.
 * Mounts cwd at the same absolute path inside the container.
 */
export async function createSandboxContainer(
  image: string,
  cwd: string,
  containerName?: string,
): Promise<string> {
  const name = containerName ?? `pi-sandboxed-${randomUUID().slice(0, 8)}`;

  // Ensure image is available
  await dockerExecRaw(["pull", "-q", image]);

  // Create and start container
  const args = [
    "run",
    "-d",
    "--rm",
    "--name", name,
    "-v", `${cwd}:${cwd}:rw`,
    image,
    "sleep", "infinity",
  ];

  const result = await dockerExecRaw(args);
  const id = result.toString().trim();

  // Verify it's running
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
  },
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const args = ["exec", "-i"];

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

/**
 * Execute a command and return stdout as a trimmed string.
 * Throws on non-zero exit.
 */
async function dockerExecRaw(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
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
