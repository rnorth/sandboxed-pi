# Configuration

## Config file

enclave reads `~/.config/enclave/config.yaml`:

```yaml
# image: ghcr.io/your/own-base:tag             # optional: override the curated base image

networkPolicies:                                # optional
  - host: api.github.com
    policies:
      - action: ALLOW
        path: /repos/.*
        method: GET
```

All keys are optional. If you supply no config file at all, enclave still exits 2 with an example — the file's existence remains a deliberate confirmation that you intend to use enclave here. `networkPolicies` follows the schema in [egress-control](./egress-control.md); if omitted or empty, enclave starts the proxy in default-deny mode and warns at startup.

`image` is an escape hatch for users who want their own base. Omitted is the common case — see [container-image](./container-image.md) for what's in the default curated image and the bring-your-own-base contract.

## cwd mount

The directory you invoke enclave from is bind-mounted at the same absolute path inside the container, read-write. Files created inside are owned by your host user (see [container-image](./container-image.md) for the per-user UID/GID layer).

There is no facility (yet) for additional mounts or environment variables. Those will land as further keys in `config.yaml` as the need arises.

## Environment overrides

| Variable | Purpose |
|---|---|
| `ENCLAVE_PROXY_IMAGE` | Override the proxy image. Useful during local development on a branch where no proxy image is published for the current package version yet. |
