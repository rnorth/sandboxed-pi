# sandboxed-pi

A Docker container sandbox extension for [pi](https://github.com/badlogic/pi-coding-agent). All tool execution (bash, read, write, edit, ls, grep, find) runs inside an ephemeral Docker container — nothing escapes to the host.

## Philosophy

**Containment, not just isolation.** Other approaches limit what tools can do (allow/deny lists, OS-level sandboxing). `sandboxed-pi` takes a harder line: every filesystem operation, every shell command, every search happens inside a container that is created on session start and destroyed on session end. The host filesystem is made available via a read-write mount of the current working directory (so your code is editable), but the container has no inherent access beyond that mount.

**Fail-closed.** If the container is unavailable, tools throw errors rather than silently falling back to host execution. The only way to run on the host is to opt out explicitly with `--no-sandbox`.

**Transparent to the LLM.** The extension overrides all seven built-in tools using pi's pluggable operations interfaces. The LLM sees the same tool interface — only the execution layer is replaced.

**Non-root by default.** Containers run as the host user (not root), so files created inside the container are owned by the host user and `$USER` / `whoami` work correctly.

## Features

- **Full tool containment** — bash, read, write, edit, ls, grep, find all execute via `docker exec`
- **Ephemeral lifecycle** — created on `session_start`, destroyed on `session_shutdown`
- **Non-root execution** — containers run as the host user with matching UID/GID
- **Custom user image** — builds `pi-sandbox-<user>:<uid>` per host user, cached across sessions
- **Container restart** — if the container crashes mid-session, tools attempt a `docker start` before failing
- **`!` / `!!` user commands** — also routed through the container
- **Act runner image** — default is `ghcr.io/catthehacker/ubuntu:act-latest` (git, node 24, python 3, curl, jq, make, gcc, docker CLI pre-installed)
- **Customizable** — edit `Dockerfile.template` to add packages or tools
- **Opt-out** — disable with `--no-sandbox`

## Quick Start

### Installation

```bash
git clone https://github.com/rnorth/sandboxed-pi ~/.pi/agent/extensions/sandboxed-pi
```

The extension is auto-discovered by pi from `~/.pi/agent/extensions/sandboxed-pi/`.

### Usage

```bash
# Start pi — container is created automatically
pi

# Custom image
pi --sandbox-image ubuntu:24.04

# Disable sandboxing (run on the host)
pi --no-sandbox

# Inside pi (interactive mode), check container status
/sandbox-status
```

Inside the container, the user identity matches the host:

```bash
whoami        # → your username (not root)
echo $HOME    # → /home/pi
echo $USER    # → your username
```

### Customizing the container

Edit `Dockerfile.template` to add packages or tools. The template uses build arguments for the user configuration:

```dockerfile
FROM ghcr.io/catthehacker/ubuntu:act-latest

ARG USER_NAME
ARG USER_UID
ARG USER_GID

# Add your customizations here
RUN apt-get update && apt-get install -y my-favorite-tool

# User is created automatically
USER ${USER_NAME}
CMD ["sleep", "infinity"]
```

The image is rebuilt on first container creation, so changes take effect on the next session. If a previously-cached image needs to be replaced, remove it manually with `docker rmi pi-sandbox-<user>:<uid>`.

## Configuration

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--sandbox-image` | string | `ghcr.io/catthehacker/ubuntu:act-latest` | Base image used to build the per-user sandbox image |
| `--no-sandbox` | boolean | `false` | Disable containerization; tools run on the host |
| `--egress-policy <file>` | string | `""` | Path to a policy file for egress control (mitmproxy sidecar). See [egress control](#egress-control) for details. |

## Egress control

When `--egress-policy` is set, a mitmproxy sidecar container filters all outbound HTTP/HTTPS traffic from the sandbox. Each request is evaluated against a per-host list of ALLOW/DENY rules (last match wins); unmatched requests and unlisted hosts return `403 Access denied by egress policy`.

This is non-voluntary — it uses iptables REDIRECT inside a shared network namespace, so it intercepts traffic from tools that ignore `HTTP_PROXY` (Go binaries, statically compiled tools, anything that opens raw sockets).

### Policy file format

```yaml
networkPolicies:
  - host: api.github.com
    policies:
      - action: DENY
        path: /.*
        method: "*"
      - action: ALLOW
        path: /repos/.*
        method: GET
      - action: ALLOW
        path: /users/.*
        method: GET

  - host: registry.npmjs.org
    policies:
      - action: ALLOW
        path: /.*
        method: "*"
```

**Schema:**

| Field | Type | Description |
|-------|------|-------------|
| `networkPolicies` | `NetworkPolicy[]` | Top-level array |
| `host` | `string` | Exact hostname to match |
| `policies` | `Rule[]` | Ordered list of allow/deny rules |
| `action` | `"ALLOW" \| "DENY"` | Rule action |
| `path` | `string` | Python regex (`re` module, `fullmatch`) — matched against the path only, query string excluded |
| `method` | `string` | HTTP method (`GET`, `POST`, `*` for all) |

**Matching semantics:**
- Rules are evaluated **top-to-bottom** (in declaration order)
- The **last matching rule** wins (like iptables)
- If no rule matches, the request is **DENIED** (default-deny)

See [`examples/github-read-only.yaml`](./examples/github-read-only.yaml) for a working example.

### How it works

```
pi --egress-policy policy.yaml
  ├── proxy container starts (NET_ADMIN, mitmproxy + iptables in entrypoint)
  ├── workload container starts with --network container:<proxy>  (shared netns)
  └── iptables REDIRECT inside that netns sends TCP 80/443 to mitmproxy:8080
        (--uid-owner exempts the proxy's own upstream traffic)

tool call → docker exec workload <cmd>
  → kernel redirects sockets to mitmproxy (transparent, ignores HTTP_PROXY)
    → policy evaluation (ALLOW/DENY rules; default-deny → 403)
    → TLS-terminate, re-encrypt to upstream
    → audit log written to /var/log/sandboxed-pi/audit.log
```

The audit log is tailed and printed to stderr (and visible in the pi UI as info notifications) as requests are processed.

### Limitations

- Only HTTP/HTTPS is intercepted. Non-HTTP protocols (SSH, etc.) are not filtered.
- DNS resolution is not intercepted — workloads can still resolve arbitrary hostnames.
- Host matching uses the TLS SNI / `Host` header, both workload-controlled. A workload can direct traffic to an arbitrary IP while presenting an allowed hostname. Full mitigation requires DNS interception (planned for v2).
- WebSocket connections are only policy-checked at the initial HTTP upgrade request. Frames sent after the upgrade are not inspected — a workload can use an allowed WebSocket endpoint as an arbitrary data channel.
- Cert-pinned clients fail against the mitmproxy CA.
- IPv6 traffic is not intercepted (only IPv4 iptables rules are set up).

## Roadmap

- [x] **MITM proxy sidecar** — control outbound network traffic from the container
- [ ] **Resource limits** — CPU/memory constraints on the container
- [ ] **Read-only rootfs** — only the mounted volume is writable

## How it works

For the runtime mechanics — lifecycle hooks, the path a tool call takes, error handling — see [docs/architecture.md](./docs/architecture.md).

For the *why* behind the design — containment model, path mounting, non-root execution, fail-closed default — see the [Architecture Decision Records](./docs/decisions/README.md).

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

Integration tests require a running Docker daemon. Unit tests mock Docker operations.

### Project structure

```
sandboxed-pi/
├── src/
│   ├── index.ts       # Extension entry point (lifecycle, tool overrides, flags)
│   ├── docker.ts      # Low-level Docker helpers (container lifecycle, exec, image build)
│   ├── ops.ts         # Operations factories for all 7 built-in tools
│   └── egress.ts      # Egress proxy lifecycle, policy parsing, audit log tailing
├── tests/
│   ├── ops.test.ts                  # Unit tests for operation factories
│   ├── egress.test.ts               # Unit tests for policy parsing and validation
│   └── docker.integration.test.ts   # Integration tests for Docker helpers
├── docs/
│   ├── architecture.md              # How the system works at runtime
│   └── decisions/                   # ADRs — why the architecture is the way it is
├── Dockerfile.template              # Template for the per-user sandbox image
├── Dockerfile.proxy                 # Image for the mitmproxy egress sidecar
├── entrypoint.sh                    # Proxy entrypoint: iptables setup + mitmdump
├── policy.py                        # mitmproxy addon: policy evaluation + audit log
└── package.json
```
