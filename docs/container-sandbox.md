# Container Sandbox

Every tool call the LLM makes — `bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`, and the `!`/`!!` user commands — runs inside an ephemeral Docker container. Nothing touches the host filesystem outside the mounted working directory.

## Why a container

pi executes tool calls directly on the host. For an AI agent that may run arbitrary commands and edit arbitrary files, that means the blast radius of a misbehaving model — or a prompt-injection attack — is the user's whole machine: shell history, SSH keys, cloud credentials, every dotfile.

Several mitigations exist in the ecosystem:

- **Allow / deny lists** for shell commands. Porous: there are too many ways to spell a destructive operation.
- **OS-level sandboxing** (macOS Seatbelt, Linux seccomp/landlock). Effective but cross-platform support is uneven and the rules are hard to write defensively.
- **Full VM** (Lima, Multipass, Firecracker). Strong isolation, heavy startup cost, awkward filesystem sharing.

`sandboxed-pi` routes every tool operation through `docker exec`. The container boundary is the containment guarantee — not an allow/deny list, not a VM. Considered alternatives:

- **Allow/deny lists for bash.** Rejected: doesn't cover read/write/edit, and shell command vocabulary is too large to enumerate safely.
- **Per-call sandboxing via OS primitives.** Rejected: macOS and Linux primitives diverge enough that a portable, defensive ruleset is impractical for this project's scope.
- **Full VM.** Rejected: startup latency and filesystem-sharing complexity outweigh the marginal isolation gain over a container, given that we already trust the Docker boundary.

## Tool coverage

The set of overridden tools is exhaustive: `bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`, plus `user_bash` for `!` and `!!` shortcuts. There is no tool that bypasses the container.

## Session lifecycle

### 1. Extension load

`activate(pi)` in `pi-extension/src/index.ts` registers everything synchronously and does no I/O:

- Flags: `--sandbox-image`, `--no-sandbox`
- Tool overrides: `bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`
- Command: `/sandbox-status`
- Event handlers: `session_start`, `before_agent_start`, `user_bash`, `session_shutdown`

No Docker calls happen here. All container work is deferred to `session_start`.

### 2. `session_start`

Runs once per pi session:

1. If `--no-sandbox` is set, mark the sandbox disabled and return. Tools fall back to local execution — see [Fail-closed](#fail-closed).
2. Probe the daemon with `docker info` (10s timeout).
3. `getHostUser()` reads `process.env.USER`, `process.getuid()`, `process.getgid()`, `process.env.HOME`.
4. `buildSandboxImage()` reads `Dockerfile.template`, substitutes build args, and runs `docker build -t pi-sandbox-<user>:<uid> -f - .`. Cached after first build for that user.
5. `createSandboxContainer()` issues `docker run -d --rm --name pi-sandboxed-<random> -v <cwd>:<cwd>:rw <image> sleep infinity` and stores the container name.
6. The UI status line is updated to show the container name.

If steps 2–5 fail, the session enters a `failed` state — see [Fail-closed](#fail-closed).

### 3. `before_agent_start`

Runs before each agent turn. Rewrites the system prompt to make the container visible to the model:

```
Current working directory: /Users/.../project (inside Docker container: pi-sandboxed-ab12cd34)
```

This is informational only — the model does nothing different with it, but it makes container state observable in transcripts.

### 4. Tool calls

Each tool override follows the same shape:

```ts
async execute(id, params, signal, onUpdate) {
  const cn = await requireContainer();
  if (!cn) return localTool.execute(id, params, signal, onUpdate);
  const tool = createTool(localCwd, { operations: createDockerOps(cn) });
  return tool.execute(id, params, signal, onUpdate);
}
```

`requireContainer()` returns the container name if the sandbox is active, or `null` if `--no-sandbox` was passed. When it returns `null`, the override delegates to the locally-bound tool.

### 5. `user_bash`

For pi's `!` and `!!` shortcuts, the `user_bash` event returns `{ operations: createDockerBashOps(cn) }` so these commands also run inside the container.

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

The pi tool factories (`createReadTool`, `createBashTool`, …) accept an `operations` injection point. Docker-backed implementations are supplied; the pi tool itself is unchanged. Every behaviour the host tool would have — argument validation, error shapes, output formatting — is preserved. Only the I/O layer is swapped.

## Per-tool operations

Each operations factory in `pi-extension/src/ops.ts` returns an object whose methods are thin wrappers around `docker exec`.

| Tool | Container command(s) |
|------|---------------------|
| `bash` | `docker exec -i -w <cwd> <ctr> bash -c <cmd>`, output streamed via `onData` |
| `read` | `docker exec <ctr> cat <path>` → stdout buffer |
| `write` | `docker exec -i <ctr> bash -c "mkdir -p $(dirname <path>) && cat > <path>"`, content piped via stdin |
| `edit` | `read` + `write` composed; no new container command |
| `ls` | `docker exec <ctr> ls -1 <path>` → newline-split entries |
| `grep` | `docker exec <ctr> test -d <path>` to distinguish files vs directories, then `cat` for matched files (pattern matching runs in pi's tool layer) |
| `find` | `docker exec <ctr> find <cwd> -type f -name <pattern>`, with `-not -path` for ignore patterns |

### Why `write` streams via stdin

The naive form would be `docker exec <ctr> bash -c "echo '<content>' > <path>"`, but command-line argument length limits make this fragile for large files. Piping the content via stdin to `cat > <path>` avoids the limit entirely. The `mkdir -p $(dirname …)` ensures intermediate directories exist.

### Path quoting

Paths reach `docker exec` as separate `argv` entries (not interpolated into a shell string), so they don't need shell-escaping in the common case. Where a shell command is built (`bash -c "…"`), paths are quoted using `JSON.stringify`, which produces a safely double-quoted form for any reasonable path.

## Container resilience

If `docker exec` is called and the container is no longer running (crashed, OOM-killed, manually stopped):

```
isContainerRunning(name)?
  yes → exec
  no  → docker start <name>
        success → exec
        failure → mark session failed, throw
```

Recreation from a clean image is **not** automatic mid-session — state accumulated in the container during the session (installed packages, working files outside the mount) would be lost, silently confusing the model. The session transitions to `failed` and subsequent tool calls throw — same fail-closed treatment as a startup failure.

## Fail-closed

A silent fallback — "Docker isn't available, run on the host" — defeats the containment guarantee without telling the user. They'd believe they were sandboxed when they weren't.

Two states, chosen at session start:

| `--no-sandbox` | Docker reachable | Behaviour |
|----------------|------------------|-----------|
| not set | yes | Containerised execution. Tools route through `docker exec`. |
| not set | no | **Fail at session_start.** Tools throw on every call; no host fallback. |
| set | (irrelevant) | Local execution. The user has explicitly opted out. |

The flag is the **only** path to local execution. No environment variable, no config-file fallback, no auto-degradation. The UI surfaces a warning ("Container sandbox disabled via --no-sandbox") when opted out, so the state is visible and auditable in shell history.

Considered alternatives:

- **Auto-fallback on Docker unavailability.** Rejected: violates the containment guarantee silently.
- **Interactive prompt when Docker is unavailable.** Rejected: pi sessions may be non-interactive (CI, scripted).
- **Treat `--no-sandbox` as a degrade-at-runtime hint.** Rejected: makes runtime behaviour depend on whether Docker came up — exactly the unpredictability we want to avoid.

## Security guarantees

What the sandbox **does** guarantee:

- No tool reads or writes the host filesystem outside the mounted working directory.
- No tool runs commands with the host shell's environment, dotfiles, or path.
- Containers are ephemeral: any state accumulated during a session is discarded at session end.
- File ownership in the mount is the host user, not root — see [Container configuration](./container-configuration.md).

What it **does not** guarantee:

- **HTTP/HTTPS filtering.** Optional — see [Egress control](./egress-control.md). Without the flag, full outbound access remains.
- **Resource limits.** No CPU, memory, or PID-count caps. A runaway loop in the container can consume host resources.
- **Read-only rootfs.** The container's root filesystem is writable; only ephemerality bounds it.
