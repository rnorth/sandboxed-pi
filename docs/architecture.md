# Architecture

This document describes the architecture and implementation of sandboxed-pi.

## Overview

`sandboxed-pi` is a pi extension that runs all tool execution inside an ephemeral Docker container. The host filesystem is made available via a read-write mount, but no tool execution escapes to the host.

```
pi session
  ├── Extension loaded
  ├── session_start
  │     ├── Get host user
  │     ├── Build custom sandbox image
  │     └── Start container
  ├── Tool execution (via docker exec)
  │     ├── bash
  │     ├── read
  │     ├── write
  │     ├── edit
  │     ├── ls
  │     ├── grep
  │     └── find
  └── session_shutdown
        └── Destroy container
```

## Project Structure

```
sandboxed-pi/
├── src/
│   ├── index.ts           # Extension entry point
│   ├── docker.ts          # Container lifecycle and docker helpers
│   └── ops.ts             # Docker-based operations factories
├── tests/
│   ├── ops.test.ts        # Unit tests for operations
│   └── docker.integration.test.ts # Integration tests
├── docs/
│   ├── non-root-user.md   # Non-root execution design
│   └── architecture.md    # This file
├── Dockerfile.template    # Custom sandbox image template
└── package.json
```

## Extension Lifecycle

### 1. Factory Function (Registration)

On extension load, `index.ts` registers:

- `--sandbox-image` flag (default: `ghcr.io/catthehacker/ubuntu:act-latest`)
- `--no-sandbox` flag (default: `false`)
- Tool overrides (bash, read, write, edit, ls, grep, find)
- Commands (`/sandbox-status`)
- Event handlers (session_start, session_shutdown, etc.)

No heavy work is done at registration time. Container creation is deferred to `session_start`.

### 2. session_start

On session start:

1. **Get host user** via `getHostUser()` → `{ name, uid, gid, home }`
2. **Build custom image** via `buildSandboxImage()` → `pi-sandbox-<name>:<uid>`
   - Reads `Dockerfile.template`
   - Substitutes build args (USER_NAME, USER_UID, USER_GID)
   - Runs `docker build`
3. **Start container** via `createSandboxContainer()`:
   ```bash
   docker run -d --rm \
     --name pi-sandboxed-<random> \
     -v /host/pwd:/host/pwd:rw \
     pi-sandbox-<name>:<uid> \
     sleep infinity
   ```
4. **Update UI** with container name and status

### 3. Tool Execution

Each tool override creates a tool with Docker-based operations:

```typescript
pi.registerTool({
  ...localBash,
  name: "bash",
  async execute(id, params, signal, onUpdate, _ctx) {
    const cn = await requireContainer();
    if (!cn) return localBash.execute(id, params, signal, onUpdate);
    const tool = createBashTool(localCwd, {
      operations: createDockerBashOps(cn),
    });
    return tool.execute(id, params, signal, onUpdate);
  },
});
```

The operations are factories that return objects implementing the operations interfaces. Each operation runs a `docker exec` command.

### 4. user_bash Event

For `!` and `!!` commands, the `user_bash` event returns custom `BashOperations` so these commands also run in the container.

### 5. session_shutdown

On session end:

```bash
docker rm -f <container>
```

The `--rm` flag ensures automatic cleanup if the container crashes.

### 6. before_agent_start

Patches the system prompt to indicate containerized execution:

```
Current working directory: /path/to/pwd (inside Docker container: pi-sandboxed-xxx)
```

## Docker Operations

### bash

```bash
docker exec -i -w <cwd> <container> bash -c "<command>"
```

Output is streamed via `onData` callback for interactive commands.

### read

```bash
docker exec <container> cat <path>
```

Returns stdout as Buffer.

### write

```bash
docker exec -i <container> bash -c "mkdir -p $(dirname <path>) && cat > <path>"
```

Content is piped via stdin to avoid argument length limits.

### ls

```bash
docker exec <container> ls -1 <path>
```

Returns directory entries split by newline.

### find

```bash
docker exec <container> find <cwd> -type f -name "<pattern>"
```

Supports `-not -path` for ignore patterns.

### grep

```bash
docker exec <container> cat <path>
docker exec <container> test -d <path>
```

### Container Restart

If container is not running before an exec:

1. Attempt `docker start <container>`
2. If that fails, recreate the container
3. If all fails, throw an error (fail-closed)

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Container not running | Attempt restart, then recreate |
| Path outside mounted volume | Docker error propagates naturally |
| Command timeout | Kill docker exec process via AbortSignal |
| Signal abort | Kill docker exec process |
| Container crash | Detect on next exec, attempt restart |
| Docker not available | Log error, disable sandboxing |

## Edge Cases

### Path Translation

Mounts at the same absolute path on host and in container:

```
-v /Users/rnorth/project:/Users/rnorth/project:rw
```

No path translation is needed. Tools resolve paths to absolute paths on the host, and Docker exec uses the same path in the container.

### Large File Writes

Content is streamed via stdin rather than passed as a command argument:

```bash
docker exec -i <container> bash -c "cat > <path>"
# stdin: file content
```

This avoids argument length limits for large files.

### Special Characters in Paths

Paths are quoted using a JSON.stringify-style approach:

```typescript
function quote(s: string): string {
  return JSON.stringify(s); // produces safe single-quoted string
}
```

### Container Name Collisions

Random suffix from `crypto.randomUUID()`:

```typescript
const name = `pi-sandboxed-${randomUUID().slice(0, 8)}`;
```

### Mac → Linux Path Semantics

Since we're mounting the host path at the same location inside the container, path translation is not needed. The container runs Linux commands on the macOS filesystem, which is compatible (Docker handles cross-platform filesystem semantics).

## Configuration

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--sandbox-image` | string | `ghcr.io/catthehacker/ubuntu:act-latest` | Base image for custom image build |
| `--no-sandbox` | boolean | `false` | Disable containerization, fall back to host execution |

## Security Considerations

- **No escape hatch**: If container is unavailable, tools throw errors
- **Non-root execution**: Containers run as the host user (see [docs/non-root-user.md](./non-root-user.md))
- **Minimal surface area**: Only the mounted working directory is accessible
- **Ephemeral containers**: Created and destroyed per session
- **No network isolation**: Outbound network traffic is not restricted (see roadmap)

## Future Improvements

See [README.md](../README.md#roadmap) for the full roadmap:

- [ ] MITM proxy sidecar for network control
- [ ] Resource limits (CPU/memory)
- [ ] Read-only rootfs