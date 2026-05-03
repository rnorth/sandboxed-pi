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

  // -----------------------------------------------------------------------
  // Mutable state (resolved lazily when flags are available)
  // -----------------------------------------------------------------------

  let containerName: string | null = null;
  let sandboxEnabled = false;
  let containerInitialized = false;

  // -----------------------------------------------------------------------
  // Container lifecycle
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      ctx.ui.notify("Container sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const image = (pi.getFlag("sandbox-image") as string) || "ghcr.io/catthehacker/ubuntu:act-latest";
    const cwd = ctx.cwd;

    try {
      // Check if Docker is available
      await pi.exec("docker", ["info", "--format", "{{.OSType}}"], { timeout: 10 });

      containerName = await createSandboxContainer(image, cwd);
      sandboxEnabled = true;
      containerInitialized = true;

      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "sandbox",
          ctx.ui.theme.fg("accent", `🐳 Container: ${containerName} (${image})`),
        );
        ctx.ui.notify(`Sandbox active: ${containerName} (${image})`, "info");
      } else {
        console.error(`[sandboxed-pi] Container active: ${containerName} (${image})`);
      }
    } catch (err) {
      sandboxEnabled = false;
      const msg = err instanceof Error ? err.message : String(err);
      // Always log to stderr since ui.notify may be no-op
      console.error(`[sandboxed-pi] Container init failed: ${msg}`);
      if (ctx.hasUI) {
        ctx.ui.notify(`Container sandbox init failed: ${msg}`, "error");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    if (containerName) {
      await destroySandboxContainer(containerName);
      containerName = null;
    }
  });

  // -----------------------------------------------------------------------
  // Helpers to get operations / check readiness
  // -----------------------------------------------------------------------

  function getContainerName(): string | null {
    return containerName;
  }

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
   * Assert the sandbox container is available. Throws if not.
   * Used by all tool overrides to fail closed.
   */
  async function requireContainer(): Promise<string> {
    const cn = getContainerName();
    if (!cn || !containerInitialized) {
      throw new Error(
        "[sandboxed-pi] Sandbox container is not available. " +
        "Tool execution outside the container is not permitted. " +
        "Start pi without --no-sandbox to enable containerization."
      );
    }

    const running = await ensureContainerRunning(cn);
    if (!running) {
      throw new Error(
        `[sandboxed-pi] Sandbox container "${cn}" is not running and could not be restarted.`
      );
    }

    return cn;
  }

  // -----------------------------------------------------------------------
  // Tool overrides
  // -----------------------------------------------------------------------

  const localCwd = process.cwd();

  // All tools use this same pattern: require the container, then build a
  // docker-based tool with the specific operations.

  pi.registerTool({
    ...createReadTool(localCwd),
    name: "read",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      const tool = createReadTool(localCwd, {
        operations: createDockerReadOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createWriteTool(localCwd),
    name: "write",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      const tool = createWriteTool(localCwd, {
        operations: createDockerWriteOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createEditTool(localCwd),
    name: "edit",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      const tool = createEditTool(localCwd, {
        operations: createDockerEditOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createBashTool(localCwd),
    name: "bash",
    label: "bash (containerized)",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      const tool = createBashTool(localCwd, {
        operations: createDockerBashOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createLsTool(localCwd),
    name: "ls",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      const tool = createLsTool(localCwd, {
        operations: createDockerLsOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createGrepTool(localCwd),
    name: "grep",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
      const tool = createGrepTool(localCwd, {
        operations: createDockerGrepOps(cn),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createFindTool(localCwd),
    name: "find",
    async execute(id, params, signal, onUpdate, _ctx) {
      const cn = await requireContainer();
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
    return { operations: createDockerBashOps(cn) };
  });

  // -----------------------------------------------------------------------
  // System prompt: reflect containerized execution
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async (event) => {
    const cn = getContainerName();
    if (cn) {
      const modified = event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${localCwd} (inside Docker container: ${cn})`,
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
      const cn = getContainerName();
      if (!cn) {
        ctx.ui.notify("🐳 Sandbox: container not initialized", "warning");
        return;
      }
      const running = await isContainerRunning(cn);
      if (running) {
        ctx.ui.notify(
          `🐳 Sandbox active: container=${cn} image=${(pi.getFlag("sandbox-image") as string) || "ghcr.io/catthehacker/ubuntu:act-latest"}`,
          "info",
        );
      } else {
        ctx.ui.notify(`🐳 Sandbox: container "${cn}" not running`, "error");
      }
    },
  });
}
