# ADR 0001: Containment via per-session ephemeral container

- **Status:** Accepted
- **Date:** 2026-05-03

## Context

[pi](https://github.com/badlogic/pi-coding-agent) executes tool calls (bash, read, write, edit, ls, grep, find) directly on the host. For an AI agent that may run arbitrary commands and edit arbitrary files, that means the blast radius of a misbehaving model — or a prompt-injection attack — is the user's whole machine: shell history, SSH keys, cloud credentials, every dotfile.

Several mitigations exist in the ecosystem:

- **Allow / deny lists** for shell commands. Porous: there are too many ways to spell a destructive operation.
- **OS-level sandboxing** (macOS Seatbelt, Linux seccomp/landlock). Effective but cross-platform support is uneven and the rules are hard to write defensively.
- **Full VM** (Lima, Multipass, Firecracker). Strong isolation, heavy startup cost, awkward filesystem sharing.

We want stronger guarantees than the first two, with less weight than the third.

## Decision

Route **every** tool operation through `docker exec` into a container that is created on `session_start` and destroyed on `session_shutdown`.

- The container mounts the working directory read-write so the agent can edit code (see [ADR 0002](./0002-mount-host-path-at-same-location.md)).
- The container runs as the host user (see [ADR 0003](./0003-non-root-via-custom-image.md)).
- If Docker is unavailable, tools fall back to local execution only when the user explicitly opts out via `--no-sandbox` (see [ADR 0004](./0004-fail-closed-with-opt-out.md)).

The set of overridden tools is exhaustive — bash, read, write, edit, ls, grep, find — plus the `user_bash` event for `!` and `!!` shell shortcuts. There is no tool that bypasses the container.

## Consequences

**Positive**

- The agent's reach is bounded by the container, not the host. Credentials, dotfiles, and unrelated directories are not visible by default.
- The pi tool interface is unchanged — overrides plug in via `BashOperations`, `ReadOperations`, etc. The model sees the same tools.
- Container is ephemeral, so any state the agent accumulates (installed packages, leftover files outside the mount) vanishes at session end.

**Negative**

- Hard dependency on a running Docker daemon.
- Per-tool latency cost from `docker exec` for each call.
- Image build cost on first session for a given user (mitigated by per-user image caching — see [ADR 0003](./0003-non-root-via-custom-image.md)).
- Network is not yet isolated. Outbound traffic from the container is not restricted; that's a planned follow-up (MITM proxy sidecar).

## Alternatives considered

- **Allow/deny lists for bash.** Rejected: doesn't cover read/write/edit, and shell command vocabulary is too large to enumerate safely.
- **Per-call sandboxing via OS primitives.** Rejected: macOS and Linux primitives diverge enough that a portable, defensive ruleset is impractical for this project's scope.
- **Full VM.** Rejected: startup latency (seconds-to-tens-of-seconds) and filesystem-sharing complexity outweigh the marginal isolation gain over a container, given that we already trust the Docker boundary.
