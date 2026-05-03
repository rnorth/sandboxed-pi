/**
 * Egress control via mitmproxy sidecar.
 *
 * Creates a proxy container that runs mitmproxy with a policy addon,
 * forcing all TCP 80/443 from the workload through the proxy via
 * iptables REDIRECT inside a shared network namespace.
 *
 * See ADR-0005 for full design.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { dockerExecRaw, isContainerRunning } from "./docker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EgressPolicy {
  /** Path to policy.yaml file */
  file: string;
  /** Map of host → allowed path patterns */
  allowlist: Record<string, string[]>;
}

export interface EgressState {
  proxyContainer: string;
  workloadContainer: string;
}

/** Parse a YAML-like policy file (host: [pattern, ...]) */
export function parsePolicyFile(filePath: string): EgressPolicy {
  const content = readFileSync(filePath, "utf-8");
  const allowlist: Record<string, string[]> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const host = trimmed.slice(0, colonIdx).trim();
    const patternsRaw = trimmed.slice(colonIdx + 1).trim();

    if (!host) continue;

    // Remove surrounding brackets if present
    const patternsStr = patternsRaw.replace(/^\[/, "").replace(/\].*$/, "");
    const patterns = patternsStr
      .split(",")
      .map((p) => p.trim().replace(/^["']|["']$/g, ""));

    allowlist[host] = patterns.filter(p => p !== "");
  }

  return { file: filePath, allowlist };
}

// ---------------------------------------------------------------------------
// Proxy container image
// ---------------------------------------------------------------------------

const PROXY_IMAGE_NAME_PREFIX = "pi-egress-proxy";

/**
 * Build the egress proxy image if not already present.
 * Uses the Dockerfile.proxy in the extension directory.
 */
export async function ensureProxyImageExists(): Promise<string> {
  const imageName = `${PROXY_IMAGE_NAME_PREFIX}:latest`;
  const dockerfilePath = resolve(__dirname, "..", "Dockerfile.proxy");
  const dockerfile = readFileSync(dockerfilePath, "utf-8");

  try {
    // Check if image already exists
    const result = await dockerExecRaw(["image", "inspect", "-f", "{{.Id}}", imageName]);
    if (result.toString().trim()) {
      return imageName; // image exists
    }
  } catch {
    // Image doesn't exist, build it
  }

  // Build the image
  await dockerExecRaw(
    ["build", "-t", imageName, "-f", "-", resolve(__dirname, "..")],
    dockerfile,
  );

  return imageName;
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

/**
 * Create the egress proxy container.
 *
 * The container runs as a sidecar with NET_ADMIN capability to set iptables
 * rules. It shares its network namespace with the workload container so
 * that TCP 80/443 redirects apply to workload traffic.
 *
 * Returns the proxy container name.
 */
export async function createProxyContainer(
  policyFile: string,
  workloadContainerName: string,
): Promise<string> {
  const proxyContainerName = `pi-egress-proxy-${randomUUID().slice(0, 8)}`;
  const proxyImage = await ensureProxyImageExists();

  // Parse policy to get allowlist
  const policy = parsePolicyFile(policyFile);

  // Write policy to a location the proxy can read
  const policyDest = `/etc/sandboxed-pi/policy.yaml`;

  // Create and start the proxy container
  // - CapAdd NET_ADMIN for iptables
  // - Shares network namespace with workload container
  // - Mount policy file
  // - Entrypoint handles iptables setup + runs mitmdump
  await dockerExecRaw([
    "run",
    "-d",
    "--rm",
    "--name", proxyContainerName,
    "--cap-add=NET_ADMIN",
    "--network", `container:${workloadContainerName}`,
    "-v", `${policyFile}:${policyDest}:ro`,
    proxyImage,
    // Entrypoint args: policy file path
    policyDest,
  ]);

  // Wait for iptables to be set up (the entrypoint script needs a moment)
  await waitForProxyReady(proxyContainerName, 15_000);

  // Install mitmproxy CA cert in the workload so standard TLS clients
  // (curl, gh, npm, etc.) trust the intercepted certificates.
  await installProxyCATrust(proxyContainerName, workloadContainerName);

  return proxyContainerName;
}

/**
 * Stop and remove the proxy container.
 */
export async function destroyProxyContainer(name: string): Promise<void> {
  try {
    await dockerExecRaw(["rm", "-f", name]);
  } catch {
    // Container might already be gone
  }
}

/**
 * Copy the mitmproxy CA certificate from the proxy container and install
 * it in the workload container's system trust store, so that HTTPS
 * interception works for standard TLS clients (curl, gh, npm, etc.).
 *
 * The cert lives at `~/.mitmproxy/mitmproxy-ca-cert.pem` inside the proxy
 * container (the default mitmproxy location). We pipe it into the workload
 * container and install it via `update-ca-certificates` (Ubuntu/Debian).
 */
export async function installProxyCATrust(
  proxyContainerName: string,
  workloadContainerName: string,
): Promise<void> {
  // mitmproxy generates its CA cert at this path by default
  const certPath = "/root/.mitmproxy/mitmproxy-ca-cert.pem";

  // Export from proxy, pipe into workload, install to system trust
  // The command inside the workload:
  //   mkdir -p /usr/local/share/ca-certificates/sandboxed-pi
  //   cat > /usr/local/share/ca-certificates/sandboxed-pi/proxy-ca.crt
  //   update-ca-certificates
  // We write the cert content via stdin to avoid shell quoting issues.
  const certDestDir = "/usr/local/share/ca-certificates/sandboxed-pi";
  const certDestFile = `${certDestDir}/proxy-ca.crt`;

  const setupCmd = `mkdir -p ${certDestDir} && cat > ${certDestFile} && update-ca-certificates`;

  // Get the cert from the proxy container and pipe it to the workload
  await dockerExecRaw([
    "exec", "-i", proxyContainerName,
    "cat", certPath,
  ], undefined).then(async (certPem) => {
    // Now run the install command in the workload, passing cert via stdin
    const installResult = await dockerExecRawWithStdin([
      "exec", "-i", workloadContainerName,
      "sh", "-c", setupCmd,
    ], certPem);

    if (installResult.toString().trim() !== "") {
      // update-ca-certificates outputs summary on success (e.g. "1 added")
      // A non-empty stderr usually means a problem; emit a warning but don't fail.
      console.error(
        `[sandboxed-pi] CA install output: ${installResult.toString().trim()}`,
      );
    }
  });
}

// Export variant that accepts stdin separately so callers can pipe content
function dockerExecRawWithStdin(args: string[], stdin: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`docker ${args[0]} failed (${code}): ${Buffer.concat(stderrChunks).toString().trim()}`));
      } else {
        resolve(Buffer.concat(stdoutChunks));
      }
    });

    child.stdin?.end(stdin);
  });
}
async function waitForProxyReady(name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // Check if iptables is configured by checking for the marker
      const result = await dockerExecRaw([
        "exec", name,
        "sh", "-c",
        "test -f /var/run/sandboxed-pi/proxy-ready && cat /var/run/sandboxed-pi/proxy-ready",
      ]);
      const status = result.toString().trim();
      if (status === "ready") {
        return; // Proxy is ready
      }
    } catch {
      // Container not ready yet, wait
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`Proxy container ${name} did not become ready within ${timeoutMs}ms`);
}

/**
 * Check if the proxy container is healthy (mitmdump is running).
 */
export async function isProxyHealthy(name: string): Promise<boolean> {
  try {
    // mitmdump should be the main process (PID 1 or in the process list)
    const result = await dockerExecRaw([
      "exec", name,
      "sh", "-c",
      "ps aux | grep -v grep | grep -q mitmdump",
    ]);
    return result.toString().trim() === "";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Audit log tailing
// ---------------------------------------------------------------------------

/**
 * Tail the audit log from the proxy container, emitting only new lines.
 * Returns an AbortController handle that stops the tail when aborted.
 *
 * Tracks file offset between polls so previously-seen entries are not
 * re-emitted. On each tick, uses `tail -c +<offset>` to read from the last
 * seen byte position, then updates the offset. If the file was truncated
 * (e.g. log rotation), the offset resets to 0.
 */
export function tailAuditLog(
  containerName: string,
  onLine: (line: string) => void,
): AbortController {
  const ac = new AbortController();
  let byteOffset = 0;

  const tick = () => {
    if (ac.signal.aborted) return;

    (async () => {
      try {
        // Get current file size and read new content from last offset.
        // `wc -c` gives us the current size so we can detect truncation.
        // We use `tail -c +<offset>` to read from that position onward.
        // If the offset is past EOF (file shrank), `tail` returns empty and
        // we reset to offset 0 on the next successful read.
        const sizeResult = await dockerExecRaw([
          "exec", containerName,
          "sh", "-c", "stat -c %s /var/log/sandboxed-pi/audit.log 2>/dev/null || echo 0",
        ]);
        const currentSize = parseInt(sizeResult.toString().trim(), 10) || 0;

        if (currentSize < byteOffset) {
          // File was truncated (or rotated) — reset offset
          byteOffset = 0;
        }

        if (byteOffset >= currentSize) {
          // No new bytes; just wait and retry
          if (!ac.signal.aborted) setTimeout(tick, 2000);
          return;
        }

        // Read from byteOffset onward
        const result = await dockerExecRaw([
          "exec", "-i", containerName,
          "sh", "-c", `tail -c +${byteOffset + 1} /var/log/sandboxed-pi/audit.log`,
        ]);

        const newContent = result.toString();
        if (newContent.length > 0) {
          for (const line of newContent.split("\n")) {
            if (line.trim()) onLine(line);
          }
          byteOffset += newContent.length;
        } else {
          // tail returned nothing — update offset to current size to avoid
          // re-reading on next tick until new data is written.
          byteOffset = currentSize;
        }
      } catch {
        // Proxy might be gone or log file missing; stop tailing
        ac.abort();
      }

      if (!ac.signal.aborted) {
        setTimeout(tick, 2000); // Poll every 2s
      }
    })();
  };

  tick();
  return ac;
}

// ---------------------------------------------------------------------------
// Policy validation
// ---------------------------------------------------------------------------

/**
 * Validate that a policy file is parseable and not empty.
 */
export function validatePolicy(filePath: string): { valid: boolean; error?: string } {
  if (!existsSync(filePath)) {
    return { valid: false, error: `Policy file not found: ${filePath}` };
  }

  try {
    const policy = parsePolicyFile(filePath);
    const hosts = Object.keys(policy.allowlist);

    if (hosts.length === 0) {
      return { valid: false, error: "Policy file has no allowlist entries" };
    }

    // Validate that at least one pattern exists per host
    for (const [host, patterns] of Object.entries(policy.allowlist)) {
      if (patterns.length === 0) {
        return { valid: false, error: `Host '${host}' has no allowed patterns` };
      }

      // Basic regex validation
      for (const pattern of patterns) {
        try {
          new RegExp(pattern);
        } catch {
          return { valid: false, error: `Invalid regex pattern for host '${host}': ${pattern}` };
        }
      }
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Failed to parse policy file: ${err}` };
  }
}