# Architecture

This document describes how `sandboxed-pi` works at runtime: the lifecycle hooks it registers, the path a tool call takes from model to container, and how container failures are handled. It is written for contributors and future maintainers.

For *why* the architecture is shaped the way it is — the trade-offs and rejected alternatives — see the [Architecture Decision Records](./decisions/README.md).

## Contents

- [Mental model](#mental-model)
- [Session lifecycle](#session-lifecycle)
- [Tool-call flow](#tool-call-flow)
- [Per-tool operations](#per-tool-operations)
- [Container resilience](#container-resilience)
- [Path handling](#path-handling)
- [Security guarantees and limits](#security-guarantees-and-limits)

## Mental model

`sandboxed-pi` is a pi extension. It registers two flags, seven tool overrides, one slash command, and a handful of lifecycle handlers. At session start it spins up a Docker container; at session end it tears the container down. In between, every tool call the model makes is translated into a `docker exec` against that container.

```
pi session
  ├── extension registered (flags, tools, commands, hooks)
  ├── session_start
  │     ├── (a) check --no-sandbox flag
  │     ├── (b) build pi-sandbox-<user>:<uid>  (cached after first build)
  │     └── (c) docker run -d --rm <image> sleep infinity
  ├── before_agent_start  → annotate system prompt with container name
  ├── tool calls          → docker exec <container> <op>
  ├── user_bash (! / !!)  → docker exec <container> bash
  └── session_shutdown    → docker rm -f <container>
```

Three load-bearing decisions shape this picture:

- **Containment is total.** Every built-in tool is overridden — see [ADR 0001](./decisions/0001-containment-via-ephemeral-container.md).
- **Paths don't translate.** The host cwd is mounted at the same absolute path inside the container — see [ADR 0002](./decisions/0002-mount-host-path-at-same-location.md).
- **The user inside the container is the host user.** A custom image is built per-user — see [ADR 0003](./decisions/0003-non-root-via-custom-image.md).

## Session lifecycle

The extension hooks into pi's lifecycle in the order events fire:

### 1. Extension load (registration)

`activate(pi)` in `src/index.ts` registers everything synchronously and does no I/O:

- Flags: `--sandbox-image`, `--no-sandbox`
- Tool overrides: `bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`
- Command: `/sandbox-status`
- Event handlers: `session_start`, `before_agent_start`, `user_bash`, `session_shutdown`

No Docker calls happen here. All container work is deferred to `session_start`.

### 2. `session_start`

Runs once per pi session. Roughly:

1. If `--no-sandbox` is set, mark the sandbox disabled and return. Tools will fall back to local execution. (See [ADR 0004](./decisions/0004-fail-closed-with-opt-out.md).)
2. Probe the daemon with `docker info` (10s timeout).
3. `getHostUser()` reads `process.env.USER`, `process.getuid()`, `process.getgid()`, `process.env.HOME`.
4. `buildSandboxImage()` reads `Dockerfile.template`, substitutes the build args, and runs `docker build -t pi-sandbox-<user>:<uid> -f - .`. Cached after first build for that user.
5. `createSandboxContainer()` issues `docker run -d --rm --name pi-sandboxed-<random> -v <cwd>:<cwd>:rw <image> sleep infinity` and stores the container name in module state.
6. The UI status line is updated to show the container name; a notification confirms the sandbox is active.

If steps 2–5 fail, the session enters a `failed` state. The session is **not** aborted — pi continues — but every subsequent tool call throws `Sandbox unavailable: …`. The user sees the failure at session start (a notification and a stderr log) and on every tool call thereafter. To recover, restart pi or relaunch with `--no-sandbox`.

### 3. `before_agent_start`

Runs before each agent turn. The handler rewrites the system prompt to make the containerized state visible to the model:

```
Current working directory: /Users/.../project (inside Docker container: pi-sandboxed-ab12cd34)
```

This is informational only — the model does nothing different with this information, but the annotation makes container state observable in transcripts.

### 4. Tool calls

Each tool override (`bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`) follows the same shape:

```ts
async execute(id, params, signal, onUpdate) {
  const cn = await requireContainer();
  if (!cn) return localTool.execute(id, params, signal, onUpdate);
  const tool = createTool(localCwd, { operations: createDockerOps(cn) });
  return tool.execute(id, params, signal, onUpdate);
}
```

`requireContainer()` returns the container name if the sandbox is active, or `null` if `--no-sandbox` was passed. When it returns `null`, the override delegates to the locally-bound tool — same factory, no `operations` override, runs on the host.

### 5. `user_bash`

For pi's `!` and `!!` shortcuts (user-typed shell commands), the `user_bash` event returns `{ operations: createDockerBashOps(cn) }` so these commands also run inside the container.

### 6. `session_shutdown`

`docker rm -f <container>`. The `--rm` flag on `docker run` is a belt-and-braces second cleanup if the process crashes before reaching this hook.

## Tool-call flow

A single tool call traces this path:

```
model → pi tool dispatch
        → sandboxed-pi override (e.g. read)
            → requireContainer()        // returns container name or null
            → createReadTool(cwd, { operations: createDockerReadOps(cn) })
                → ReadOperations.read(path)
                    → docker exec <cn> cat <path>
                    → return Buffer
            → tool result back to pi → back to model
```

The pi tool factories (`createReadTool`, `createBashTool`, …) accept an `operations` injection point. Our overrides supply Docker-backed implementations of those operations interfaces; the pi tool itself is unchanged. That means every behavior the host tool would have — argument validation, error shapes, output formatting — is preserved. We're only swapping out the I/O layer.

## Per-tool operations

Each operations factory in `src/ops.ts` returns an object whose methods are thin wrappers around `docker exec`.

| Tool | Container command(s) |
|------|---------------------|
| `bash` | `docker exec -i -w <cwd> <ctr> bash -c <cmd>`, output streamed via `onData` |
| `read` | `docker exec <ctr> cat <path>` → stdout buffer |
| `write` | `docker exec -i <ctr> bash -c "mkdir -p $(dirname <path>) && cat > <path>"`, content piped via stdin |
| `edit` | `read` + `write` composed; no new container command |
| `ls` | `docker exec <ctr> ls -1 <path>` → newline-split entries |
| `grep` | `docker exec <ctr> test -d <path>` to distinguish files vs directories, then `cat` for matched files (the grep pattern matching itself runs in pi's tool layer) |
| `find` | `docker exec <ctr> find <cwd> -type f -name <pattern>`, with `-not -path` for ignore patterns |

### Why `write` streams via stdin

The naive form would be `docker exec <ctr> bash -c "echo '<content>' > <path>"`, but command-line argument length limits make this fragile for large files. Piping the content via stdin to `cat > <path>` avoids the limit entirely. The `mkdir -p $(dirname …)` ensures intermediate directories exist.

### Path quoting

Paths reach `docker exec` as separate `argv` entries (not interpolated into a shell string), so they don't need shell-escaping in the common case. Where we do build a shell command (`bash -c "…"`), paths are quoted using `JSON.stringify`, which produces a safely double-quoted form for any reasonable path.

## Container resilience

If `docker exec` is called and the container is no longer running (crashed, OOM-killed, manually stopped), the helper attempts recovery before giving up:

```
isContainerRunning(name)?
  yes → exec
  no  → docker start <name>
        success → exec
        failure → mark session failed, throw
```

Recreation from a clean image is **not** automatic mid-session. State accumulated in the container during the session (installed packages, working files outside the mount) would be lost on recreate, which would silently confuse the model. The session transitions to `failed` and subsequent tool calls throw — same fail-closed treatment as a startup failure.

## Path handling

The container mounts the host working directory at the same absolute path inside the container — see [ADR 0002](./decisions/0002-mount-host-path-at-same-location.md). Practical implications:

- Tools see and produce paths in host form (e.g. `/Users/alice/project/foo.ts`); the container resolves them identically. No translator.
- macOS-shaped paths work inside a Linux container because Docker's filesystem layer handles the cross-platform semantics; we never have to think about it.
- Paths *outside* the mount don't exist in the container. A tool call that targets `/etc/...` or `~/.ssh/...` will fail at the container boundary, not in some translation step. This is the containment guarantee made concrete.

## Security guarantees and limits

What the architecture **does** guarantee:

- No tool reads or writes the host filesystem outside the mounted working directory.
- No tool runs commands with the host shell's environment, dotfiles, or path.
- Containers are ephemeral: any state accumulated during a session is discarded at session end.
- File ownership in the mount is the host user, not root — see [ADR 0003](./decisions/0003-non-root-via-custom-image.md).

What it **does not** guarantee yet:

- ~~Network isolation.~~ The container now has optional egress control via `--egress-policy` and a mitmproxy sidecar. Without the flag, full outbound access remains.
- **Resource limits.** No CPU, memory, or PID-count caps. A runaway loop in the container can consume host resources.
- **Read-only rootfs.** The container's root filesystem is writable; only ephemerality bounds it.

These are tracked in the [README roadmap](../README.md#roadmap).
