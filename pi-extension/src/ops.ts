/**
 * Docker-based operations factories for all built-in tools.
 *
 * Each function returns an operations object conforming to the corresponding
 * Operations interface (ReadOperations, WriteOperations, BashOperations, etc.)
 */

import type {
  BashOperations,
  ReadOperations,
  WriteOperations,
  EditOperations,
  LsOperations,
  GrepOperations,
  FindOperations,
} from "@mariozechner/pi-coding-agent";
import { execInContainer } from "./docker.js";

// ---------------------------------------------------------------------------
// ReadOperations
// ---------------------------------------------------------------------------

export function createDockerReadOps(containerName: string): ReadOperations {
  return {
    async readFile(path) {
      const { exitCode, stdout, stderr } = await execInContainer(containerName, [
        "cat", path,
      ]);
      if (exitCode !== 0) {
        throw new Error(`read failed: ${stderr.toString().trim()}`);
      }
      return stdout;
    },

    async access(path) {
      const { exitCode, stderr } = await execInContainer(containerName, [
        "test", "-r", path,
      ]);
      if (exitCode !== 0) {
        throw new Error(`File not readable: ${path} — ${stderr.toString().trim()}`);
      }
    },

    async detectImageMimeType(path) {
      try {
        const { exitCode, stdout } = await execInContainer(containerName, [
          "file", "--mime-type", "-b", path,
        ]);
        if (exitCode !== 0) return null;
        const mime = stdout.toString().trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// WriteOperations
// ---------------------------------------------------------------------------

export function createDockerWriteOps(containerName: string): WriteOperations {
  return {
    async writeFile(path, content) {
      const { exitCode, stderr } = await execInContainer(
        containerName,
        ["bash", "-c", `mkdir -p "$(dirname ${quote(path)})" && cat > ${quote(path)}`],
        { stdin: content },
      );
      if (exitCode !== 0) {
        throw new Error(`write failed: ${stderr.toString().trim()}`);
      }
    },

    async mkdir(dir) {
      const { exitCode, stderr } = await execInContainer(containerName, [
        "mkdir", "-p", dir,
      ]);
      if (exitCode !== 0) {
        throw new Error(`mkdir failed: ${stderr.toString().trim()}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// EditOperations (composed from read + write)
// ---------------------------------------------------------------------------

export function createDockerEditOps(containerName: string): EditOperations {
  const readOps = createDockerReadOps(containerName);
  const writeOps = createDockerWriteOps(containerName);

  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  };
}

// ---------------------------------------------------------------------------
// BashOperations
// ---------------------------------------------------------------------------

export function createDockerBashOps(containerName: string): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env: _env }) {
      // Intentionally ignore host environment variables (including PATH)
      // to prevent host paths from leaking into the container. The container
      // has its own natively configured environment.

      const { exitCode } = await execInContainer(
        containerName,
        ["bash", "-c", command],
        { cwd, onData, signal, timeout },
      );

      return { exitCode };
    },
  };
}

// ---------------------------------------------------------------------------
// LsOperations
// ---------------------------------------------------------------------------

export function createDockerLsOps(containerName: string): LsOperations {
  return {
    async exists(path) {
      const { exitCode } = await execInContainer(containerName, ["test", "-e", path]);
      return exitCode === 0;
    },

    async stat(path) {
      const { exitCode, stdout, stderr } = await execInContainer(containerName, [
        "stat", "--format=%F", path,
      ]);
      if (exitCode !== 0) {
        throw new Error(`stat failed: ${stderr.toString().trim()}`);
      }
      const type = stdout.toString().trim();
      return {
        isDirectory(): boolean {
          return type === "directory";
        },
      };
    },

    async readdir(path) {
      const { exitCode, stdout, stderr } = await execInContainer(containerName, [
        "ls", "-1", path,
      ]);
      if (exitCode !== 0) {
        throw new Error(`readdir failed: ${stderr.toString().trim()}`);
      }
      const output = stdout.toString().trim();
      return output ? output.split("\n") : [];
    },
  };
}

// ---------------------------------------------------------------------------
// GrepOperations
// ---------------------------------------------------------------------------

export function createDockerGrepOps(containerName: string): GrepOperations {
  return {
    async isDirectory(path) {
      const { exitCode } = await execInContainer(containerName, ["test", "-d", path]);
      return exitCode === 0;
    },

    async readFile(path) {
      const { exitCode, stdout, stderr } = await execInContainer(containerName, [
        "cat", path,
      ]);
      if (exitCode !== 0) {
        throw new Error(`readFile for grep failed: ${stderr.toString().trim()}`);
      }
      return stdout.toString();
    },
  };
}

// ---------------------------------------------------------------------------
// FindOperations
// ---------------------------------------------------------------------------

export function createDockerFindOps(containerName: string): FindOperations {
  return {
    async exists(path) {
      const { exitCode } = await execInContainer(containerName, ["test", "-e", path]);
      return exitCode === 0;
    },

    async glob(pattern, cwd, { ignore, limit }) {
      // Build ignore patterns
      const ignoreExprs = ignore
        .map((pat) => `-not -path './${pat}'`)
        .join(" ");

      // Use find with -name matching
      let cmd = `find . -type f -name ${quote(pattern)} ${ignoreExprs} -print`;
      if (limit > 0) {
        cmd += ` | head -${limit}`;
      }

      const { exitCode, stdout, stderr } = await execInContainer(
        containerName,
        ["bash", "-c", cmd],
        { cwd },
      );

      if (exitCode !== 0) {
        throw new Error(`glob failed: ${stderr.toString().trim()}`);
      }

      const output = stdout.toString().trim();
      if (!output) return [];

      // Resolve relative paths to absolute
      return output.split("\n").map((p) => {
        // Remove leading ./ and prepend cwd
        const rel = p.startsWith("./") ? p.slice(2) : p;
        return `${cwd}/${rel}`;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Shell-quote a path for use in docker exec bash -c.
 * Uses JSON.stringify which produces a safe single-quoted-ish string.
 */
function quote(s: string): string {
  return JSON.stringify(s);
}
