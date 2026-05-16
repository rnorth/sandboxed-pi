#!/usr/bin/env node
/**
 * enclave: run any program inside an ephemeral Docker container.
 *
 * Usage: enclave -- <program> [args...]
 *
 * Config: ~/.config/enclave/config.yaml
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgv, UsageError } from "./argv.js";
import { loadConfig, ConfigError, type Config } from "./config.js";
import { buildEnclaveImage } from "./image.js";
import {
  createSandboxContainer,
  destroySandboxContainer,
  dockerExecRaw,
} from "./docker.js";
import {
  createProxyContainerFromPolicy,
  destroyProxyContainer,
  tailAuditLog,
} from "./egress.js";

const DEFAULT_CONFIG_PATH = resolve(homedir(), ".config", "enclave", "config.yaml");

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgv(process.argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  let config: Config;
  try {
    config = loadConfig(DEFAULT_CONFIG_PATH);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[enclave] ${err.message}`);
      return 2;
    }
    throw err;
  }

  // Default-deny warning. Egress is always-on; with no policies the
  // proxy boots in default-deny mode (everything blocked).
  if (config.defaultDenyActive()) {
    console.error(
      "[enclave] No networkPolicies in config — all outbound HTTP/HTTPS will be blocked.",
    );
    console.error(
      `[enclave] To allow specific hosts, add a networkPolicies section to ${DEFAULT_CONFIG_PATH}.`,
    );
  }

  try {
    await dockerExecRaw(["info", "--format", "{{.OSType}}"]);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    console.error(`[enclave] Docker daemon not reachable: ${cause}`);
    return 1;
  }

  let workload: string | undefined;
  let proxy: string | undefined;
  let auditTailer: AbortController | undefined;
  let cleanupPolicyFile: (() => void) | undefined;

  try {
    const imageName = await buildEnclaveImage(config.image);
    workload = await createSandboxContainer(imageName, process.cwd());

    // Always run an egress proxy: an explicit policy when present, a
    // default-deny empty-policy otherwise.
    const policy = { networkPolicies: config.networkPolicies ?? [] };
    const proxyResult = await createProxyContainerFromPolicy(policy, workload);
    proxy = proxyResult.proxyContainer;
    cleanupPolicyFile = proxyResult.cleanup;

    auditTailer = tailAuditLog(proxy, (line) => {
      console.error(`[enclave] [egress] ${line}`);
    });

    return await runInside(workload, parsed.innerCommand);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    console.error(`[enclave] ${cause}`);
    return 1;
  } finally {
    if (auditTailer) auditTailer.abort();
    // Proxy goes down before the workload: the workload's network
    // namespace is shared with the proxy, so the order matters on
    // teardown.
    if (proxy) {
      try {
        await destroyProxyContainer(proxy);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        console.error(`[enclave] cleanup: failed to destroy proxy ${proxy}: ${cause}`);
      }
    }
    if (workload) {
      try {
        await destroySandboxContainer(workload);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        console.error(`[enclave] cleanup: failed to destroy workload ${workload}: ${cause}`);
      }
    }
    if (cleanupPolicyFile) cleanupPolicyFile();
  }
}

/**
 * Run the user's program inside the workload via `docker exec`.
 * Inherits stdio so the terminal is connected end-to-end. Returns
 * the inner program's exit code.
 */
function runInside(containerName: string, command: string[]): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const flags = interactive ? ["-it"] : ["-i"];

    const child = spawn(
      "docker",
      ["exec", ...flags, containerName, ...command],
      { stdio: "inherit" },
    );

    const forward = (sig: NodeJS.Signals) => {
      try { child.kill(sig); } catch { /* already gone */ }
    };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    const onWinch = () => forward("SIGWINCH");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    process.on("SIGWINCH", onWinch);

    child.on("error", rejectP);
    child.on("close", (code, signal) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.off("SIGWINCH", onWinch);

      if (signal) {
        // Posix convention: 128 + signal number. We map SIGINT to 130
        // (the conventional shell value) and anything else to 1.
        resolveP(signal === "SIGINT" ? 130 : 1);
      } else {
        resolveP(code ?? 1);
      }
    });
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[enclave] unexpected error:", err);
    process.exit(1);
  },
);
