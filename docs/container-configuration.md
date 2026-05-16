# Configuration and the per-user image

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

`image` is an escape hatch for users who want their own base. Omitted is the common case.

## Image stack

enclave's container is built in two stages so the slow-changing curated layer is shared across all users on the host and the per-user layer stays tiny.

```
ubuntu:24.04
      │
      │  Dockerfile.base  (curated tools + mise)
      ▼
enclave-base:dev
      │
      │  Dockerfile.template  (per-user UID/GID/name)
      ▼
enclave-<USER>:<UID>
```

### Curated base image (`enclave-base`)

On first invocation, enclave builds `enclave-base:dev` from `enclave/Dockerfile.base`. It carries a small high-leverage tool set so you get a usable dev environment out of the box without per-user setup:

- **Core:** `ca-certificates`, `curl`, `wget`, `gnupg`, `git`, `openssh-client`, `less`, `bash` + completion
- **CLI helpers:** `jq`, `ripgrep`, `fd-find`, `tree`, `unzip`, `xz-utils`, `vim-tiny`, `nano`, `procps`, `lsof`, `dnsutils`
- **Build tooling:** `build-essential`, `make` — for native extensions during `pip install` / `npm install` and similar
- **GitHub CLI:** `gh` (apt repo)
- **Docker CLI:** `docker-ce-cli` — client only, no daemon, no socket assumptions
- **[mise](https://mise.jdx.dev/):** for installing language runtimes (Node, Python, Go, Ruby, Java, Bun, Deno, …) on demand inside the container

Language runtimes are **not** preinstalled. Use `mise install <tool>@<version>` (or a `.tool-versions` / `.mise.toml` in your project) to bring in what you need.

mise is wired up two ways so it works for both interactive and non-interactive use:

- **Interactive bash shells** (`docker exec -it ...`): `eval "$(mise activate bash)"` is in `/etc/bash.bashrc`. You get directory-scoped version switching and the usual prompt integration.
- **Non-interactive subprocesses** (e.g. `enclave -- node script.js`): the per-user image puts mise's shims directory (`$HOME/.local/share/mise/shims`) on `PATH` via `ENV`, so installed tools resolve without a shell hook.

The curated image is rebuilt by Docker's build cache when its `Dockerfile.base` changes. To force a rebuild: `docker image rm enclave-base:dev`. For local development of the curated image, set `ENCLAVE_BASE_IMAGE` to a tag of your choice.

If you set `image` in your config, the curated image is **not** built — your base image is used verbatim and only the per-user UID/GID layer is added on top. You're on your own for the tool set in that case.

### Per-user image (`enclave-<USER>:<UID>`)

On top of the curated base (or your `image` override), enclave bakes in the host user:

- A user is created matching the host's UID/GID/name.
- The home directory is `/home/<USER>`.
- `USER` and `HOME` env vars are set.
- mise shims are prepended to `PATH`.
- Default shell is `/bin/bash` (required for mise's bash activation).

The result is cached as `enclave-<USER>:<UID>`. Rebuilds are cheap once Docker has the layers. Force a rebuild with `docker image rm enclave-<USER>:<UID>`.

The base must be Debian/Ubuntu-derived (apt-get is used in the curated image; the per-user layer itself uses only `useradd`/`groupadd`, so it works on any image that has those).

## cwd mount

The directory you invoke enclave from is bind-mounted at the same absolute path inside the container, read-write. Files created inside are owned by your host user.

There is no facility (yet) for additional mounts or environment variables. Those will land as further keys in `config.yaml` as the need arises.

## Ephemerality

The container is destroyed when the program exits. Anything installed inside — including tools added via `mise install` mid-session — is gone next invocation. Persistent mise data is a known follow-up; for now, codify runtime versions in your project's `.mise.toml` / `.tool-versions` and re-install per session if needed.

## Environment overrides

| Variable | Purpose |
|---|---|
| `ENCLAVE_BASE_IMAGE` | Override the curated base image tag. Useful when iterating on `Dockerfile.base` locally. |
| `ENCLAVE_PROXY_IMAGE` | Override the proxy image. Useful during local development on a branch where no proxy image is published for the current package version yet. |
