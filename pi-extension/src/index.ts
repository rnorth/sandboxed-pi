/**
 * sandboxed-pi: Docker container sandbox for pi tools.
 *
 * On session start, creates a Docker container with the current working
 * directory mounted rw. All built-in tools (bash, read, write, edit, ls,
 * grep, find) are overridden to execute inside the container via docker exec.
 *
 * No tool execution escapes to the host.
 *
 * Usage:
 *   pi (autoloads from ~/.pi/agent/extensions/sandboxed-pi/)
 *   pi --sandbox-image ubuntu:24.04     # Custom image
 *   pi --no-sandbox                    # Disable container sandboxing
 *   pi --egress-policy policy.yaml     # Enable egress filtering via mitmproxy
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { createSandboxContainer, destroySandboxContainer, isContainerRunning } from "./docker.js";
import {
  createDockerBashOps,
  createDockerEditOps,
  createDockerFindOps,
  createDockerGrepOps,
  createDockerLsOps,
  createDockerReadOps,
  createDockerWriteOps,
} from "./ops.js";
import {
  createProxyContainer,
  destroyProxyContainer,
  validatePolicy,
  tailAuditLog,
} from "./egress.js";

export default function (pi: ExtensionAPI) {
  // -----------------------------------------------------------------------
  // CLI flags
  // -----------------------------------------------------------------------

  pi.registerFlag("sandbox-image", {
    description: "Docker image for the sandbox container (default: ghcr.io/catthehacker/ubuntu:act-latest)",
    type: "string",
    default: "ghcr.io/catthehacker/ubuntu:act-latest",
  });

  pi.registerFlag("no-sandbox", {
    description: "Disable Docker container sandboxing",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("egress-policy", {
    description:
      "Path to a policy.yaml file for egress control. When set, a mitmproxy sidecar filters outbound HTTP/HTTPS traffic.",
    type: "string",
    default: "",
  });

  pi.registerFlag("proxy-image", {
    description:
      "Pre-built local proxy image to use instead of pulling from ghcr.io. For development use.",
    type: "string",
    default: "",
  });

  // -----------------------------------------------------------------------
  // Mutable state (resolved lazily when flags are available)
  // -----------------------------------------------------------------------

  type SandboxState =
    | { kind: "pending" } // before session_start has run
    | { kind: "disabled" } // user passed --no-sandbox (extension is a no-op)
    | { kind: "active"; container: string; proxyContainer?: string } // containers are running
    | { kind: "failed"; reason: string }; // user wanted sandbox but it is not available

  let state: SandboxState = { kind: "pending" };
  let auditTailer: AbortController | undefined;

  // -----------------------------------------------------------------------
  // Egress proxy helpers
  // -----------------------------------------------------------------------

  async function startEgressProxy(
    policyFile: string,
    workloadContainer: string,
    proxyImage?: string,
  ): Promise<{ proxyContainer: string; auditTailer: AbortController }> {
    const proxyContainer = await createProxyContainer(policyFile, workloadContainer, proxyImage);

    const tailer = tailAuditLog(proxyContainer, (line) => {
      console.error(`[sandboxed-pi] [egress] ${line}`);
    });

    console.error(`[sandboxed-pi] Egress proxy started: ${proxyContainer}`);

    return { proxyContainer, auditTailer: tailer };
  }

  async function stopEgressProxy(proxyContainer: string, tailer: AbortController): Promise<void> {
    tailer.abort();
    await destroyProxyContainer(proxyContainer);
  }

  // -----------------------------------------------------------------------
  // Container lifecycle
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("no-sandbox") as boolean) {
      state = { kind: "disabled" };
      ctx.ui.notify("Container sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const image = (pi.getFlag("sandbox-image") as string) || "ghcr.io/catthehacker/ubuntu:act-latest";
    const cwd = ctx.cwd;
    const policyFile = (pi.getFlag("egress-policy") as string) || "";
    const proxyImageOverride = (pi.getFlag("proxy-image") as string) || undefined;

    // Validate egress policy before starting containers
    if (policyFile) {
      const validation = validatePolicy(policyFile);
      if (!validation.valid) {
        const msg = `Egress policy validation failed: ${validation.error}`;
        state = { kind: "failed", reason: msg };
        console.error(`[sandboxed-pi] ${msg}`);
        if (ctx.hasUI) {
          ctx.ui.notify(`Egress policy error: ${validation.error}`, "error");
        }
        return;
      }
    }

    try {
      await pi.exec("docker", ["info", "--format", "{{.OSType}}"], { timeout: 10 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state = { kind: "failed", reason: msg };
      console.error(`[sandboxed-pi] Container init failed: ${msg}`);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Container sandbox init failed: ${msg}. Tools will error until you restart pi or pass --no-sandbox.`,
          "error",
        );
      }
      return;
    }

    let container: string | undefined;
    let proxyContainer: string | undefined;

    // Create workload container
    try {
      container = await createSandboxContainer(image, cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state = { kind: "failed", reason: msg };
      console.error(`[sandboxed-pi] Container init failed: ${msg}`);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Container sandbox init failed: ${msg}. Tools will error until you restart pi or pass --no-sandbox.`,
          "error",
        );
      }
      return;
    }

    // Create proxy sidecar if egress policy is configured
    if (policyFile) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Starting egress proxy — iptables + CA cert setup (up to ~30s)…`, "info");
      }
      try {
        const result = await startEgressProxy(policyFile, container, proxyImageOverride);
        proxyContainer = result.proxyContainer;
        auditTailer = result.auditTailer;

        if (ctx.hasUI) {
          ctx.ui.notify(`Egress policy active: ${policyFile}`, "info");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sandboxed-pi] Proxy setup failed: ${msg}`);

        // Clean up the workload container before transitioning to failed
        if (container) {
          try {
            await destroySandboxContainer(container);
          } catch {
            console.error(`[sandboxed-pi] Failed to clean up workload container ${container} during proxy failure`);
          }
        }

        state = { kind: "failed", reason: msg };
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Egress proxy failed: ${msg}. Tools will error until you restart pi or pass --no-sandbox.`,
            "error",
          );
        }
        return;
      }
    }

    // All containers up — transition to active state
    state = { kind: "active", container, proxyContainer };

    if (ctx.hasUI) {
      const suffix = proxyContainer ? ` | proxy: ${proxyContainer}` : "";
      ctx.ui.setStatus(
        "sandbox",
        ctx.ui.theme.fg("accent", `🐳 Container: ${container} (${image})${suffix}`),
      );
      ctx.ui.notify(`Sandbox active: ${container} (${image})`, "info");
    } else {
      const suffix = proxyContainer ? ` | proxy: ${proxyContainer}` : "";
      console.error(`[sandboxed-pi] Container active: ${container} (${image})${suffix}`);
    }
  });

  pi.on("session_shutdown", async () => {
    if (state.kind === "active") {
      // Destroy proxy container first (workload depends on proxy's netns)
      if (state.proxyContainer && auditTailer) {
        await stopEgressProxy(state.proxyContainer, auditTailer);
        auditTailer = undefined;
      }
      await destroySandboxContainer(state.container);
      state = { kind: "pending" };
    }
  });

  // -----------------------------------------------------------------------
  // Helpers to get operations / check readiness
  // -----------------------------------------------------------------------

  async function ensureContainerRunning(name: string): Promise<boolean> {
    const running = await isContainerRunning(name);
    if (running) return true;

    // Try to restart
    try {
      await pi.exec("docker", ["start", name]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns the container name to route tool calls through, or null if the
   * user opted out via --no-sandbox. Throws if the user wanted sandboxing
   * but it is not available — fail-closed.
   */
  async function requireContainer(): Promise<string | null> {
    switch (state.kind) {
      case "disabled":
        return null;
      case "pending":
        throw new Error("Sandbox not initialized (session_start did not complete).");
      case "failed":
        throw new Error(
          `Sandbox unavailable: ${state.reason}. Restart pi or pass --no-sandbox to run on the host.`,
        );
      case "active": {
        const running = await ensureContainerRunning(state.container);
        if (!running) {
          state = {
            kind: "failed",
            reason: `container ${state.container} stopped and could not be restarted`,
          };
          throw new Error(
            `Sandbox unavailable: ${state.reason}. Restart pi or pass --no-sandbox to run on the host.`,
          );
        }
        return state.container;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Tool overrides
  // -----------------------------------------------------------------------

  const localCwd = process.cwd();

  // For each tool: route through docker ops when the sandbox is active,
  // fall back to the local tool when the user opted out via --no-sandbox.
  // If the user wanted a sandbox but it is unavailable, requireContainer
  // throws and the error propagates as a tool failure.

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const localLs = createLsTool(localCwd);
  const localGrep = createGrepTool(localCwd);
  const localFind = createFindTool(localCwd);

  pi.registerTool({
    ...localRead,
    name: "read",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      if (!cn) return localRead.execute(id, params, signal, onUpdate);
      const tool = createReadTool(localCwd, {
        operations: createDockerReadOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    name: "write",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      if (!cn) return localWrite.execute(id, params, signal, onUpdate);
      const tool = createWriteTool(localCwd, {
        operations: createDockerWriteOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    name: "edit",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      if (!cn) return localEdit.execute(id, params, signal, onUpdate);
      const tool = createEditTool(localCwd, {
        operations: createDockerEditOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    name: "bash",
    label: "bash (containerized)",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      if (!cn) return localBash.execute(id, params, signal, onUpdate);
      const tool = createBashTool(localCwd, {
        operations: createDockerBashOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    name: "ls",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      if (!cn) return localLs.execute(id, params, signal, onUpdate);
      const tool = createLsTool(localCwd, {
        operations: createDockerLsOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    name: "grep",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      if (!cn) return localGrep.execute(id, params, signal, onUpdate);
      const tool = createGrepTool(localCwd, {
        operations: createDockerGrepOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    name: "find",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      if (!cn) return localFind.execute(id, params, signal, onUpdate);
      const tool = createFindTool(localCwd, {
        operations: createDockerFindOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // -----------------------------------------------------------------------
  // user_bash: handle `!` and `!!` commands
  // -----------------------------------------------------------------------

  pi.on("user_bash", async () => {
    const cn = await requireContainer();
    if (!cn) return;
    return { operations: createDockerBashOps(cn) };
  });

  // -----------------------------------------------------------------------
  // System prompt: reflect containerized execution
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async (event) => {
    if (state.kind === "active") {
      const proxyNote = state.proxyContainer
        ? ` with egress filtering (policy: ${(pi.getFlag("egress-policy") as string) || ""})`
        : "";
      const modified = event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${localCwd} (inside Docker container: ${state.container}${proxyNote})`,
      );
      return { systemPrompt: modified };
    }
  });

  // -----------------------------------------------------------------------
  // /sandbox-status command
  // -----------------------------------------------------------------------

  pi.registerCommand("sandbox-status", {
    description: "Show sandbox container status",
    handler: async (_args, ctx) => {
      switch (state.kind) {
        case "pending":
          ctx.ui.notify("🐳 Sandbox: not initialized yet", "warning");
          return;
        case "disabled":
          ctx.ui.notify("🐳 Sandbox: disabled via --no-sandbox", "warning");
          return;
        case "failed":
          ctx.ui.notify(`🐳 Sandbox: failed (${state.reason})`, "error");
          return;
        case "active": {
          const image =
            (pi.getFlag("sandbox-image") as string) || "ghcr.io/catthehacker/ubuntu:act-latest";
          const running = await isContainerRunning(state.container);
          const proxySuffix = state.proxyContainer
            ? ` | proxy: ${state.proxyContainer} (${(pi.getFlag("egress-policy") as string) || ""})`
            : "";
          if (running) {
            ctx.ui.notify(
              `🐳 Sandbox active: container=${state.container} image=${image}${proxySuffix}`,
              "info",
            );
          } else {
            ctx.ui.notify(`🐳 Sandbox: container "${state.container}" not running`, "error");
          }
          return;
        }
      }
    },
  });
}
