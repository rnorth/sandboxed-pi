# Container sandbox

enclave runs the user's program inside an ephemeral Docker container — *the whole program*, not just selected tool calls. There is no host-side execution path: if the container cannot start, enclave exits non-zero.

## Lifecycle

One container per invocation. The container is created when enclave starts and destroyed when the program exits. There is no daemon, no shared state between invocations, and no session concept.

## Working directory

The cwd at the point of invocation is bind-mounted at the same absolute path inside the container, read-write. Files you create from inside are owned by your host user (see [container-configuration](./container-configuration.md)).

## Containment model

Once the program is running inside `docker exec`, every subprocess it spawns — every shell command, every file read, every network call — happens inside the container. There is no leakage to the host because there is no host-side interception layer to leak through.

## Fail-closed

- No config file → exit 2, with an example config printed.
- Config schema invalid → exit 2.
- Docker daemon unreachable → exit 1.
- Image build fails → exit 1.
- Proxy fails to start → exit 1, workload is torn down first.

There is no `--no-sandbox` opt-out. If you don't want a sandbox, don't use enclave.

## Sandbox-bypass risks (do not enable)

The curated image includes the **Docker CLI client**. The client alone is harmless — it can't talk to anything without a Docker daemon socket on the other end. Specifically: **never mount `/var/run/docker.sock` into the workload container.** Doing so gives the sandboxed program full control of the host's Docker daemon, which trivially escalates to host root (e.g., `docker run -v /:/host …`). enclave does not currently expose a mounts configuration; if one is added in the future, the Docker socket must not be a casual config toggle. Treat it as out-of-band, requires-justification, separate-from-normal-mounts.
