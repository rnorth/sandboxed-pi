# ADR 0002: Mount the host working directory at the same absolute path inside the container

- **Status:** Accepted
- **Date:** 2026-05-03

## Context

pi's built-in tools resolve user-supplied paths to **absolute host paths** before handing them to the operations layer. A `Read` of `./foo.ts` becomes `/Users/alice/project/foo.ts` by the time our `ReadOperations` implementation sees it.

If the container mounts the working directory at a different path — say, `/workspace` — every operation must translate `/Users/alice/project/foo.ts` → `/workspace/foo.ts` before issuing the `docker exec`. That translation has to happen in every tool, has to handle absolute paths the model produces directly (e.g. from a previous tool's output), and breaks the moment a tool emits a path the translator wasn't expecting.

## Decision

Bind-mount the working directory at the **same absolute path** inside the container as on the host:

```
docker run -v /Users/alice/project:/Users/alice/project:rw ...
```

A path that resolves on the host also resolves in the container, byte-for-byte. No translation layer.

## Consequences

**Positive**

- Operations layer is trivially simple: hand the host path to `docker exec` unchanged.
- Tool output is consistent — paths the agent sees match what it would see running locally.
- macOS-style paths (`/Users/...`) work inside a Linux container without ceremony; Docker's filesystem layer handles the cross-platform semantics.
- Symlinks, relative paths produced by tools, and anything else pi resolves continues to work.

**Negative**

- The container's filesystem layout reflects the host's working-directory path (e.g. `/Users/alice/project` exists inside a Linux container). Tools that hard-code `/workspace` or expect a conventional layout won't find it. None of pi's built-ins do this, but a user customizing `Dockerfile.template` could be surprised.
- The mount path leaks the host username into the container. For this threat model (the user owns both sides) that's not a concern, but it is a consideration if the image is ever shared.

## Alternatives considered

- **Mount at `/workspace` and translate paths.** Rejected: every tool override would need a translator, and any path the agent emits directly would have to be translated at the right boundaries. High surface area for subtle bugs.
- **Mount at `/workspace` and `chdir` only.** Rejected: solves relative paths but not absolute ones, which pi produces routinely.
