# sandboxed-pi

A Docker container sandbox extension for [pi](https://github.com/badlogic/pi-coding-agent). All tool execution (bash, read, write, edit, ls, grep, find) runs inside an ephemeral Docker container — nothing escapes to the host.

## Philosophy

**Containment, not just isolation.** Other approaches limit what tools can do (allow/deny lists, OS-level sandboxing). `sandboxed-pi` takes a harder line: every filesystem operation, every shell command, every search happens inside a container that is created on session start and destroyed on session end. The host filesystem is made available via a read-write mount of the current working directory (so your code is editable), but the container has no inherent access beyond that mount.

**Fail-closed.** If the container is unavailable, tools throw errors rather than silently falling back to host execution. There is no escape hatch.

**Transparent to the LLM.** The extension overrides all seven built-in tools using pi's pluggable operations interfaces (`ReadOperations`, `WriteOperations`, `BashOperations`, etc.). The LLM sees the same tool interface — just the execution layer is replaced.

## Features

- **Full tool containment** — bash, read, write, edit, ls, grep, find all execute via `docker exec`
- **Ephemeral container lifecycle** — created on `session_start`, destroyed on `session_shutdown`
- **Container restart** — if the container crashes mid-session, tools attempt a `docker start` before failing
- **`!` / `!!` user commands** — also routed through the container
- **System prompt annotation** — pi's system prompt is updated to show containerized execution
- **Act runner image** — default image is `ghcr.io/catthehacker/ubuntu:act-latest`, giving you git, node 24, python 3, curl, jq, make, gcc, and docker CLI pre-installed
- **Custom image support** — override with `--sandbox-image <image>`
- **Configurable** — disable with `--no-sandbox`

## Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/rnorth/sandboxed-pi ~/.pi/agent/extensions/sandboxed-pi
```

Or symlink into place:

```bash
git clone https://github.com/rnorth/sandboxed-pi /path/to/workspace
ln -s /path/to/workspace ~/.pi/agent/extensions/sandboxed-pi
```

The extension is auto-discovered by pi from `~/.pi/agent/extensions/sandboxed-pi/`.

### Usage

```bash
# Start pi — container is created automatically
pi

# Custom image
pi --sandbox-image ubuntu:24.04

# Disable sandboxing
pi --no-sandbox

# Check container status (inside pi, interactive mode)
/sandbox-status
```

### Roadmap

- **MITM proxy sidecar** — control outbound network traffic from the container
- **Resource limits** — CPU/memory constraints on the container
- **Read-only rootfs** — container root filesystem is read-only, only the mounted volume is writable

## How It Works

```
pi session_start
  │
  ├─► docker pull ghcr.io/catthehacker/ubuntu:act-latest
  ├─► docker run -d --rm -v /host/pwd:/host/pwd:rw ... sleep infinity
  │
  ├─► tool call (e.g. ls)
  │     ├─► requireContainer() — checks container is alive
  │     ├─► createLsTool(cwd, { operations: dockerOps })
  │     └─► docker exec <container> ls -1 <path>
  │
  └─► session_shutdown
        └─► docker rm -f <container>
```

The key insight: every file read, file write, shell command, directory listing, grep search, and file find is translated into a `docker exec` call. Paths are resolved by pi's tool code to absolute paths, and since the container mounts `pwd` at the same absolute path, no path translation is needed.

### Tools Overridden

| Tool | Operations Interface | Container Command |
|------|-------------------|-------------------|
| `bash` | `BashOperations` | `docker exec -i -w <cwd> <ctr> bash -c <cmd>` |
| `read` | `ReadOperations` | `docker exec <ctr> cat <path>` |
| `write` | `WriteOperations` | `docker exec -i <ctr> bash -c 'cat > <path>'` (streams content via stdin) |
| `edit` | `EditOperations` | Combines read + write operations |
| `ls` | `LsOperations` | `docker exec <ctr> ls -1 <path>` |
| `grep` | `GrepOperations` | `docker exec <ctr> cat <path>`, `test -d <path>` |
| `find` | `FindOperations` | `docker exec <ctr> find <cwd> -type f -name <pattern>` |

## Configuration

The extension supports two CLI flags:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--sandbox-image` | string | `ghcr.io/catthehacker/ubuntu:act-latest` | Docker image |
| `--no-sandbox` | boolean | `false` | Disable containerization |

## Development

### Prerequisites

- Docker
- Node.js 22+
- [pi](https://github.com/badlogic/pi-coding-agent)

### Setup

```bash
npm install
```

### Test

```bash
npm test
```

Tests mock Docker — no Docker daemon required for unit tests.

### Project Structure

```
sandboxed-pi/
├── src/
│   ├── index.ts       # Extension entry point (lifecycle, tool overrides, flags)
│   ├── docker.ts      # Low-level Docker helpers (container lifecycle, exec)
│   └── ops.ts         # Operations factories for all 7 built-in tools
├── tests/
│   ├── ops.test.ts    # Tests for operation factories
│   └── docker.test.ts # Tests for Docker helpers
├── package.json       # Project metadata and scripts
├── tsconfig.json
└── README.md
```
