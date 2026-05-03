# ADR 0003: Non-root execution via a custom image built per host user

- **Status:** Accepted
- **Date:** 2026-05-03
- **Supersedes:** earlier `--entrypoint` script approach (no formal ADR)

## Context

A container running as root creates several problems:

- Files written into the bind-mounted working directory are owned by `root` on the host, not the user. After a session, the user has to `sudo chown -R` to recover.
- `whoami` returns `root`, `$USER` is unset or `root`, and `id` shows uid=0. Tools and scripts that branch on user identity get the wrong answer.
- A vulnerability that escapes the container's process boundary lands as root on the host filesystem (via the mount).

The container therefore needs to run as the **host user** — same UID, same GID, same name, with `whoami` and `$USER` agreeing.

That is harder than it sounds. The host user almost certainly does not exist in the base image's `/etc/passwd`. Two common workarounds each have problems:

- **`docker run --user uid:gid`** runs the process as the right UID, but `/etc/passwd` has no entry for it. `whoami` errors. Tools that look up the username from the UID get nothing useful.
- **`--entrypoint` with a setup script** can `useradd` at startup, then `exec gosu` into the user. It works, but the setup runs every container start, the script has to be defensive about pre-existing users from previous starts, and debugging it is annoying.

## Decision

Build a **custom image** at runtime, with the user baked in via Dockerfile instructions:

- `groupadd -f -g <gid> <name>` and `useradd -u <uid> -g <gid> -d /home/pi -m -s /bin/sh <name>`
- `ENV HOME=/home/pi` and `ENV USER=<name>`
- `USER <name>` instruction so `docker run` defaults to the right user
- Home directory is `/home/pi` — a fixed path inside the container, not the host's `$HOME`. Avoids mounting or reflecting the host home.

The image is tagged **per-user**:

```
pi-sandbox-<username>:<uid>
```

so it is built once per user (not per session) and reused across pi sessions for that user. The base image is configurable via `--sandbox-image`; the customization layer is in `Dockerfile.template`.

The Dockerfile uses `groupadd -f` so the build is **idempotent** — if the GID already exists in the base image (e.g. some macOS GIDs collide with `dialout` on Ubuntu), it reuses that group rather than failing.

## Consequences

**Positive**

- `whoami`, `id`, `$USER`, `$HOME` all reflect the host user. Tools that branch on identity behave correctly.
- Files created in the mounted working directory are owned by the host user with no post-session cleanup.
- The image is cached per-user — no `useradd` cost on every container start.
- `Dockerfile.template` is in the repo, so users can add packages or tools and rebuild on next session.
- The base image is not modified. The customization is a thin layer on top of whatever the user picks via `--sandbox-image`.

**Negative**

- First session for a given user pays an image-build cost (seconds; mostly the base image pull).
- Image rebuild is not automatic on `Dockerfile.template` changes — the user has to delete the cached image (or we need to add a content-hash check; see Future).
- `/home/pi` is a fixed path that doesn't reflect the host's home. Tools that read `~/.somerc` find nothing inside the container. This is intentional — see [ADR 0001](./0001-containment-via-ephemeral-container.md) — but worth being aware of.

## Alternatives considered

- **`docker run --user uid:gid`.** Rejected: no `/etc/passwd` entry, so `whoami` and reverse UID lookups fail.
- **`--entrypoint` setup script.** Rejected: runs on every start, has to be defensive about repeat invocations, and harder to reason about than a build-time decision.
- **Mount the host's `$HOME` as `/home/<user>`.** Rejected: explicitly defeats the containment goal — the agent gets read access to dotfiles, SSH keys, and credentials.

## Future

- **Cache invalidation:** detect base-image-digest or `Dockerfile.template` content changes and rebuild automatically.
- **Pre-build:** build the image at extension load time rather than first session_start, to amortize cost.
