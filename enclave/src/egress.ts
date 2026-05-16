/**
 * Egress control via mitmproxy sidecar.
 *
 * Creates a proxy container that runs mitmproxy with a policy addon,
 * forcing all TCP 80/443 from the workload through the proxy via
 * iptables REDIRECT inside a shared network namespace.
 *
 * See ADR-0005 for full design.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, isAbsolute } from "node:path";
import { dockerExecRaw, isContainerRunning } from "./docker.js";

// ---------------------------------------------------------------------------
// Proxy container image
// ---------------------------------------------------------------------------

const PROXY_IMAGE_REPO = "ghcr.io/rnorth/sandboxed-pi/proxy";

function getPackageVersion(): string {
  // package.json lives at enclave/package.json. From src/egress.ts the
  // relative path is ../package.json; from the compiled dist/src/egress.js
  // it is ../../package.json. Probe both so the lookup works in either
  // mode (vitest/tsx source vs installed bin).
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const text = readFileSync(resolve(here, rel), "utf-8");
      return (JSON.parse(text) as { version: string }).version;
    } catch {
      // try next candidate
    }
  }
  throw new Error("[enclave] could not locate package.json");
}

/**
 * Resolve the proxy image to use.
 *
 * If `proxyImage` is provided (via --proxy-image flag), use it as-is.
 * Otherwise ensure ghcr.io/rnorth/sandboxed-pi/proxy:<version> is available
 * locally: skip the pull if already present, pull if missing, and throw if the
 * pull fails. This avoids unnecessary registry round-trips and works in
 * offline/air-gapped environments when the image is already cached.
 *
 * Note: `getPackageVersion()` is implicitly tested here because the unit
 * tests assert the resolved image name contains the semver tag from
 * package.json — there's no need for a separate test on the helper.
 */
export async function resolveProxyImage(proxyImage?: string): Promise<string> {
  if (proxyImage) {
    return proxyImage;
  }
  const version = getPackageVersion();
  const imageName = `${PROXY_IMAGE_REPO}:${version}`;

  // Skip pull if the image is already present locally.
  try {
    const id = await dockerExecRaw(["image", "inspect", "-f", "{{.Id}}", imageName]);
    if (id.toString().trim()) {
      return imageName;
    }
  } catch {
    // Image not present locally — fall through to pull.
  }

  try {
    await dockerExecRaw(["pull", imageName]);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to pull proxy image ${imageName}: ${cause}`);
  }
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
  proxyImageOverride?: string,
): Promise<string> {
  const proxyContainerName = `pi-egress-proxy-${randomUUID().slice(0, 8)}`;
  const image = await resolveProxyImage(proxyImageOverride);

  // Resolve policy file to absolute path for Docker volume mount
  const policyFilePath = isAbsolute(policyFile)
    ? policyFile
    : resolve(process.cwd(), policyFile);

  console.error(`[sandboxed-pi] [egress] Starting proxy container: ${proxyContainerName}`);

  // Write policy to a location the proxy can read
  const policyDest = `/etc/sandboxed-pi/policy.yaml`;


  // Create and start the proxy container
  // - CapAdd NET_ADMIN for iptables
  // - Shares network namespace with workload container
  // - Mount policy file
  // - Entrypoint handles iptables setup + runs mitmdump
  console.error(`[sandboxed-pi] [egress] Creating proxy container (this may take a moment)...`);

  await dockerExecRaw([
    "run",
    "-d",
    "--rm",
    "--name", proxyContainerName,
    "--cap-add=NET_ADMIN",
    "--network", `container:${workloadContainerName}`,
    "-v", `${policyFilePath}:${policyDest}:ro`,
    image,
    // Entrypoint args: policy file path
    policyDest,
  ]);

  console.error(`[sandboxed-pi] [egress] Waiting for proxy to initialize (setting up iptables + CA cert)...`);

  // Wait for iptables to be set up (the entrypoint script needs a moment)
  // CA cert generation can take up to ~140s in worst case (20 retries × 7s each)
  await waitForProxyReady(proxyContainerName, 180_000);

  // Install mitmproxy CA cert in the workload so standard TLS clients
  // (curl, gh, npm, etc.) trust the intercepted certificates.
  console.error(`[sandboxed-pi] [egress] Installing proxy CA certificate in workload...`);
  await installProxyCATrust(proxyContainerName, workloadContainerName);
  console.error(`[sandboxed-pi] [egress] Proxy setup complete. All egress traffic will be filtered.`);

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
 * container (the default mitmproxy location). The entrypoint generates it
 * before signalling `ready`, so it is always present when this is called.
 */
export async function installProxyCATrust(
  proxyContainerName: string,
  workloadContainerName: string,
): Promise<void> {
  const certPath = "/root/.mitmproxy/mitmproxy-ca-cert.pem";
  const certDestDir = "/usr/local/share/ca-certificates/sandboxed-pi";
  const certDestFile = `${certDestDir}/proxy-ca.crt`;

  // Export from proxy, pipe into workload, install to system trust.
  // The workload container runs as the host (non-root) user, but writing to
  // /usr/local/share/ca-certificates and running update-ca-certificates both
  // require root, so we override the exec user for this step only.
  const certPem = await dockerExecRaw([
    "exec", "-i", proxyContainerName,
    "cat", certPath,
  ]);

  const installResult = await dockerExecRaw([
    "exec", "-i", "--user", "root", workloadContainerName,
    "sh", "-c", `mkdir -p ${certDestDir} && cat > ${certDestFile} && update-ca-certificates >&2`,
  ], certPem);

  // update-ca-certificates always prints to stdout (e.g. "1 added, 0 removed").
  // An exit code of 0 means success regardless of stdout content, so there's
  // nothing to warn on here — keep silent on success.
  if (installResult.toString().trim() !== "") {
    // Rare: something unexpected was written to stdout. Log it.
    console.error(`[sandboxed-pi] CA install stdout: ${installResult.toString().trim()}`);
  }
}
async function waitForProxyReady(name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const startTime = Date.now();
  let lastLogTime = 0;
  let loggedExecFailure = false;

  console.error(`[sandboxed-pi] [egress] Waiting for proxy to be ready (timeout: ${timeoutMs}ms)...`);

  while (Date.now() < deadline) {
    try {
      // First check if container still exists and is running
      const inspectResult = await dockerExecRaw([
        "inspect", "-f", "{{.State.Running}}", name,
      ]);
      const isRunning = inspectResult.toString().trim();

      if (isRunning !== "true") {
        // Container exists but is not running - get logs and fail
        console.error(`[sandboxed-pi] [egress] Container is not running. Fetching logs...`);
        const logsResult = await dockerExecRaw([
          "logs", "--tail", "100", name,
        ]);
        const logs = logsResult.toString();
        if (logs.trim()) {
          console.error(`[sandboxed-pi] [egress] Container stopped. Logs:\n${logs}`);
        }
        throw new Error(`Proxy container ${name} stopped unexpectedly`);
      }

      // First verify container accepts commands with a simple echo
      try {
        await dockerExecRaw([
          "exec", name,
          "echo", "healthcheck",
        ]);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[sandboxed-pi] [egress] Container not accepting commands yet: ${errMsg}`);
        continue;
      }

      // Check if iptables is configured by checking for the marker
      const result = await dockerExecRaw([
        "exec", name,
        "sh", "-c",
        "test -f /var/run/sandboxed-pi/proxy-ready && cat /var/run/sandboxed-pi/proxy-ready",
      ]);
      const status = result.toString().trim();
      if (status === "ready") {
        const elapsed = Date.now() - startTime;
        console.error(`[sandboxed-pi] [egress] Proxy ready after ${elapsed}ms`);
        return; // Proxy is ready
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("stopped unexpectedly")) {
        throw err;
      }
      // Log exec failure once at the beginning
      if (!loggedExecFailure) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[sandboxed-pi] [egress] Exec failed (container may still be starting): ${errMsg}`);
        loggedExecFailure = true;
      }
      // Container not ready yet, wait
    }

    // Log progress every 10 seconds
    const elapsed = Date.now() - startTime;
    if (elapsed - lastLogTime >= 10000) {
      lastLogTime = elapsed;
      console.error(`[sandboxed-pi] [egress] Still waiting... (${elapsed}ms elapsed)`);

      // Try to fetch logs
      try {
        const logsResult = await dockerExecRaw([
          "logs", "--tail", "30", name,
        ]);
        const logs = logsResult.toString();
        if (logs.trim()) {
          console.error(`[sandboxed-pi] [egress] Proxy logs:\n${logs}`);
        }
      } catch {
        // Ignore
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  // On timeout, dump logs for debugging
  console.error(`[sandboxed-pi] [egress] Timeout reached. Fetching final container logs...`);
  try {
    const logsResult = await dockerExecRaw([
      "logs", "--tail", "100", name,
    ]);
    const logs = logsResult.toString();
    if (logs.trim()) {
      console.error(`[sandboxed-pi] [egress] Proxy container logs on timeout:\n${logs}`);
    } else {
      console.error(`[sandboxed-pi] [egress] Proxy container has no logs`);
    }
  } catch (err) {
    console.error(`[sandboxed-pi] [egress] Failed to fetch container logs: ${err}`);
  }

  throw new Error(`Proxy container ${name} did not become ready within ${timeoutMs}ms`);
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
        // Proxy exec failed (container gone or transient). Keep retrying
        // — only abort if the signal was explicitly cancelled.
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

export function validatePolicy(filePath: string): { valid: boolean; error?: string } {
  if (!existsSync(filePath)) {
    return { valid: false, error: `Policy file not found: ${filePath}` };
  }
  return { valid: true };
}