# Container image

enclave runs your program inside a container built from an enclave-curated Ubuntu base. This doc covers what's in that image, how it's built, and how language runtimes work.

## Image stack

The workload container is built in two stages so the slow-changing curated layer is shared across all users on the host and the per-user layer stays tiny.

```
ubuntu:24.04
      │
      │  Dockerfile.base  (curated tools + mise)
      ▼
enclave-base:latest
      │
      │  Dockerfile.template  (per-user UID/GID/name)
      ▼
enclave-<USER>:<UID>
```

## Curated base image (`enclave-base`)

On first invocation, enclave builds `enclave-base:latest` from `enclave/Dockerfile.base`. It carries a small high-leverage tool set so you get a usable dev environment out of the box without per-user setup:

- **Core:** `ca-certificates`, `curl`, `wget`, `gnupg`, `git`, `openssh-client`, `less`, `bash` + completion
- **CLI helpers:** `jq`, `ripgrep`, `fd-find`, `tree`, `unzip`, `xz-utils`, `vim-tiny`, `nano`, `procps`, `lsof`, `dnsutils`
- **Build tooling:** `build-essential`, `make` — for native extensions during `pip install` / `npm install` and similar
- **GitHub CLI:** `gh` (apt repo)
- **Docker CLI:** `docker-ce-cli` — client only, no daemon, no socket assumptions (see [container-sandbox](./container-sandbox.md) for why mounting the Docker socket would be a sandbox bypass)
- **[mise](https://mise.jdx.dev/):** for installing language runtimes (Node, Python, Go, Ruby, Java, Bun, Deno, …) on demand inside the container

Language runtimes are **not** preinstalled. Use `mise install <tool>@<version>` (or a `.tool-versions` / `.mise.toml` in your project) to bring in what you need.

The curated image is rebuilt by Docker's build cache when `Dockerfile.base` changes. To force a rebuild: `docker image rm enclave-base:latest`.

## mise integration

mise is wired up two ways so it works for both interactive and non-interactive use:

- **Interactive bash shells** (`docker exec -it ...`): a `case $- in *i*) eval "$(mise activate bash)" ;; esac` line is appended to `/etc/bash.bashrc`. The `*i*` guard keeps the hook from firing for non-interactive `bash -c` invocations. You get directory-scoped version switching and the usual prompt integration.
- **Non-interactive subprocesses** (e.g. `enclave -- node script.js`): the per-user image puts mise's shims directory (`$HOME/.local/share/mise/shims`) on `PATH` via `ENV`, so installed tools resolve without a shell hook.

### Ephemerality

> **The container is destroyed when the program exits.** Anything installed at runtime — including language runtimes added via `mise install` mid-session — is gone next invocation.

The practical workflow: keep your runtime versions in a checked-in `.mise.toml` (or `.tool-versions`) at your project root. When enclave starts, run `mise install` once to bring the versions in. Re-run per session — or have your wrapped tool do it as part of its startup. mise's downloads are fast (a few seconds for prebuilt binaries) once the manifest is decided.

Persistent mise data across invocations is a known follow-up; it would be a config-driven volume mount for `~/.local/share/mise`.

## Per-user image (`enclave-<USER>:<UID>`)

On top of the curated base (or your `image` override — see [container-configuration](./container-configuration.md)), enclave bakes in the host user:

- A user is created matching the host's UID/GID/name.
- The home directory is `/home/<USER>`.
- `USER` and `HOME` env vars are set.
- mise shims are prepended to `PATH`.
- Default shell is `/bin/bash` (required for mise's bash activation).

The result is cached as `enclave-<USER>:<UID>`. Rebuilds are cheap once Docker has the layers. Force a rebuild with `docker image rm enclave-<USER>:<UID>`.

The base must be Debian/Ubuntu-derived (apt-get is used in the curated image; the per-user layer itself uses only `useradd`/`groupadd`, so it works on any image that has those).

## Bringing your own base

Setting `image` in `config.yaml` skips the curated image entirely — your image is used verbatim and only the per-user UID/GID layer is added on top. You're responsible for the tool set in that case. The override image **must include `bash`**, because the per-user layer sets the login shell to `/bin/bash` (required for mise's bash activation hook). Sticking to Debian/Ubuntu bases is the safest path.
