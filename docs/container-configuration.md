# Container Configuration

How the sandbox container is configured to match the host environment: path mounting and user identity.

## Path mounting

pi's built-in tools resolve user-supplied paths to **absolute host paths** before handing them to the operations layer. A `Read` of `./foo.ts` becomes `/Users/alice/project/foo.ts` by the time `ReadOperations` sees it.

If the container mounted the working directory at a different path — say, `/workspace` — every operation would need to translate `/Users/alice/project/foo.ts` → `/workspace/foo.ts`. That translation would have to happen in every tool, handle absolute paths the model produces directly (e.g. from a previous tool's output), and break the moment a tool emitted a path the translator wasn't expecting.

Instead, the working directory is bind-mounted at the **same absolute path** inside the container:

```
docker run -v /Users/alice/project:/Users/alice/project:rw ...
```

A path that resolves on the host also resolves in the container, byte-for-byte. No translation layer.

Practical implications:

- Operations are trivially simple: hand the host path to `docker exec` unchanged.
- Tool output is consistent — paths the agent sees match what it would see running locally.
- macOS-style paths (`/Users/...`) work inside a Linux container without ceremony; Docker's filesystem layer handles cross-platform semantics.
- Paths *outside* the mount don't exist in the container. A tool call targeting `/etc/...` or `~/.ssh/...` fails at the container boundary, not in some translation step. This is the containment guarantee made concrete.

Note: the container's filesystem layout reflects the host working-directory path (e.g. `/Users/alice/project` exists inside a Linux container). Tools that hard-code `/workspace` or expect a conventional layout won't find it.

Considered alternatives:

- **Mount at `/workspace` and translate paths.** Rejected: every tool override would need a translator, and any path the agent emits directly would need translation at the right boundaries. High surface area for subtle bugs.
- **Mount at `/workspace` and `chdir` only.** Rejected: solves relative paths but not absolute ones, which pi produces routinely.

## Non-root execution

A container running as root creates several problems:

- Files written into the bind-mounted working directory are owned by `root` on the host. After a session, the user has to `sudo chown -R` to recover.
- `whoami` returns `root`, `$USER` is unset or `root`, and `id` shows uid=0. Tools and scripts that branch on user identity get the wrong answer.
- A vulnerability that escapes the container's process boundary lands as root on the host filesystem via the mount.

The container must run as the **host user** — same UID, same GID, same name, with `whoami` and `$USER` agreeing.

That is harder than it sounds. The host user almost certainly does not exist in the base image's `/etc/passwd`. Two common workarounds each have problems:

- **`docker run --user uid:gid`** runs the process as the right UID, but `/etc/passwd` has no entry for it. `whoami` errors. Tools that look up the username from the UID get nothing useful.
- **`--entrypoint` with a setup script** can `useradd` at startup, then `exec gosu` into the user. It works, but the setup runs on every container start and is harder to reason about than a build-time decision.

`sandboxed-pi` builds a **custom image** per host user, with the user baked in via Dockerfile instructions:

- `groupadd -f -g <gid> <name>` and `useradd -u <uid> -g <gid> -d /home/pi -m -s /bin/sh <name>`
- `ENV HOME=/home/pi` and `ENV USER=<name>`
- `USER <name>` instruction so `docker run` defaults to the right user

Home directory is `/home/pi` — a fixed path inside the container, not the host's `$HOME`. This is intentional: mounting the host home would give the agent read access to dotfiles, SSH keys, and credentials.

The image is tagged `pi-sandbox-<username>:<uid>` and cached — built once per user, reused across sessions. The base image is configurable via `--sandbox-image`; the customization layer is `Dockerfile.template` in the repo.

The Dockerfile uses `groupadd -f` so the build is idempotent — if the GID already exists in the base image (e.g. some macOS GIDs collide with `dialout` on Ubuntu), it reuses that group rather than failing.

Results:

- `whoami`, `id`, `$USER`, `$HOME` all reflect the host user. Tools that branch on identity behave correctly.
- Files created in the mounted working directory are owned by the host user with no post-session cleanup.
- The image is cached — no `useradd` cost on every container start.

Note: `/home/pi` is a fixed path inside the container and doesn't reflect the host's `$HOME`. Tools that read `~/.somerc` find nothing inside the container — this is intentional, not a bug.

Considered alternatives:

- **`docker run --user uid:gid`.** Rejected: no `/etc/passwd` entry, so `whoami` and reverse UID lookups fail.
- **`--entrypoint` setup script.** Rejected: runs on every start, has to be defensive about repeat invocations, and harder to reason about than a build-time decision.
- **Mount the host's `$HOME` as `/home/<user>`.** Rejected: explicitly defeats the containment goal — the agent gets read access to dotfiles, SSH keys, and credentials.
