# sandboxed-pi: Architecture

`sandboxed-pi` routes every tool call the LLM makes through `docker exec` into an ephemeral container — nothing escapes to the host. This document is a high-level orientation; each feature has its own doc.

## Philosophy

**Containment, not just isolation.** Other approaches limit what tools can do (allow/deny lists, OS-level sandboxing). `sandboxed-pi` takes a harder line: every filesystem operation, every shell command, every search happens inside a container that is created on session start and destroyed on session end.

**Fail-closed.** If the container is unavailable, tools throw errors rather than silently falling back to host execution. The only way to run on the host is to opt out explicitly with `--no-sandbox`.

**Transparent to the LLM.** The extension overrides all seven built-in tools using pi's pluggable operations interfaces. The LLM sees the same tool interface — only the execution layer is replaced.

## Session overview

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

## Feature docs

- **[Container sandbox](./container-sandbox.md)** — containment model, session lifecycle, tool-call flow, per-tool operations, container resilience, fail-closed behaviour
- **[Container configuration](./container-configuration.md)** — path mounting (same absolute path, no translation), non-root execution (custom image per host user)
- **[Egress control](./egress-control.md)** — optional outbound HTTP/HTTPS filtering via mitmproxy sidecar, policy file format, known limitations
