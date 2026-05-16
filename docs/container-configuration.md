# Configuration and the per-user image

## Config file

enclave reads `~/.config/enclave/config.yaml`:

```yaml
image: ghcr.io/catthehacker/ubuntu:act-latest    # required: base image

networkPolicies:                                  # optional
  - host: api.github.com
    policies:
      - action: ALLOW
        path: /repos/.*
        method: GET
```

`image` is the only required key. `networkPolicies` follows the schema in [egress-control](./egress-control.md); if omitted or empty, enclave starts the proxy in default-deny mode and warns at startup.

## Per-user image

On first invocation, enclave builds a derivative of `config.image` with the host user baked in:

- A user is created matching the host's UID/GID/name.
- The home directory is `/home/<USER>`.
- `USER` and `HOME` env vars are set.
- The `gh` CLI is installed (apt-get; the base image must be Debian/Ubuntu-derived).

The result is cached as `enclave-<USER>:<UID>`. Rebuilds are cheap once the layers are in Docker's cache. If your base image changes and you want to force a rebuild, `docker image rm enclave-<USER>:<UID>` clears the cache.

The Dockerfile template that produces the derivative is intentionally small — user creation and the `gh` install. Anything else (language runtimes, other CLIs) is the responsibility of your base image.

## cwd mount

The directory you invoke enclave from is bind-mounted at the same absolute path inside the container, read-write. Files created inside are owned by your host user.

There is no facility (yet) for additional mounts or environment variables. Those will land as further keys in `config.yaml` as the need arises.

## Environment overrides

| Variable | Purpose |
|---|---|
| `ENCLAVE_PROXY_IMAGE` | Override the proxy image. Useful during local development on a branch where no proxy image is published for the current package version yet. |
