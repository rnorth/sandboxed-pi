# Non-Root Container Execution

This document describes the design decisions and implementation of running sandboxed containers as the host user (not root).

## Problem

Running containers as root is a security risk and causes practical problems:

- Files created inside the container are owned by root, not the host user
- `whoami` returns `root`, confusing tools and scripts that expect the host username
- `id` shows uid=0 instead of the host user's uid
- `$USER` environment variable is often unset or `root`
- Any security vulnerability in the container gives root access to mounted volumes

## Design Goals

1. **Correct user context** — `whoami`, `id`, `$USER`, `$HOME` all reflect the host user
2. **Correct file ownership** — files created in mounted volumes are owned by the host user
3. **No host mutations** — do not chown mounted volumes (would affect host filesystem)
4. **Customizable** — users can edit a Dockerfile to add tools/packages
5. **Idempotent** — multiple builds for the same user should work (e.g., after base image updates)

## Solution: Custom Image Built at Runtime

Instead of using `--user` and `--entrypoint` at container run time, we build a custom Docker image with the user baked in at build time.

### Why Not `--user` Flag?

The `--user uid:gid` flag tells Docker to run the container as a specific user. However:

- The user still doesn't exist in `/etc/passwd` inside the container
- `whoami` fails because there's no entry for that UID
- `id` works (it resolves UID directly) but shows no username

### Why Not `--entrypoint` Script?

The previous implementation used `--entrypoint "/bin/sh"` with a `-c` script that created the user before running the main command. However:

- The script runs as root first, creating user/group entries
- These changes may not persist correctly across container restarts
- More complex and harder to debug

### Why Custom Image?

A custom image built at runtime:

- Bakes the user into `/etc/passwd` and `/etc/group` permanently
- `USER` instruction sets the default user, so `whoami` works
- `ENV` instructions set `HOME` and `USER` correctly
- Single image build, reused for all containers
- Editable via `Dockerfile.template`

## Implementation

### Image Naming

```
pi-sandbox-<username>:<uid>
```

Example: `pi-sandbox-rnorth:501`

The image is named per-user (not per-session), so it's reused across pi sessions. When the base image updates or the user changes, the image is rebuilt.

### Image Build Process

1. **Read** `Dockerfile.template` from the extension directory
2. **Substitute** build args with host user values:
   - `USER_NAME` → `rnorth`
   - `USER_UID` → `501`
   - `USER_GID` → `20`
3. **Build** via `docker build -t pi-sandbox-rnorth:501 -f - .`

### Dockerfile.template

```dockerfile
FROM ghcr.io/catthehacker/ubuntu:act-latest

ARG USER_NAME
ARG USER_UID
ARG USER_GID

# Create /home/pi as home directory
RUN mkdir -p /home/pi && chown ${USER_UID}:${USER_GID} /home/pi

# Create user with matching UID/GID
RUN groupadd -f -g ${USER_GID} ${USER_NAME} && \
    useradd -u ${USER_UID} -g ${USER_GID} -d /home/pi -m -s /bin/sh ${USER_NAME}

# Ensure home dir is owned correctly
RUN chown -R ${USER_UID}:${USER_GID} /home/pi

# Set environment variables
ENV HOME=/home/pi
ENV USER=${USER_NAME}

# Set default user for docker run
USER ${USER_NAME}

CMD ["sleep", "infinity"]
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `/home/pi` as home, not host home | Avoids mounting host home directory; `/home/pi` is always available |
| `groupadd -f` | Idempotent: uses existing group if GID already exists |
| `USER <name>` instruction | Sets default user so `docker run` starts as the correct user |
| `ENV HOME=/home/pi` | Sets correct home path regardless of mount |
| `ENV USER=<name>` | Sets USER variable (not set by default in all images) |
| Image named per user, not per session | Avoids rebuilding on every pi session |

## Environment Inside Container

After these changes, the container environment is:

```
$ whoami
rnorth

$ id
uid=501(rnorth) gid=20(dialout) groups=20(dialout)

$ echo $HOME
/home/pi

$ echo $USER
rnorth

$ ls -la /home/pi
total 4 drwxr-x 6 rnorth dialout 192 May  3 09:31 /home/pi
```

## Customization

Users can edit `Dockerfile.template` to add packages or tools:

```dockerfile
FROM ghcr.io/catthehacker/ubuntu:act-latest

ARG USER_NAME
ARG USER_UID
ARG USER_GID

# Add your customizations here
RUN apt-get update && apt-get install -y my-tool && rm -rf /var/lib/apt/lists/*

# ... rest of template ...
```

The image is rebuilt on first container creation, so changes take effect automatically.

## Future Improvements

- [ ] **Cache image build** — check if image needs rebuilding (based on base image digest, template contents)
- [ ] **Multi-user support** — allow different users to share the same base image with different user configs
- [ ] **Image pre-build** — build image on extension load, not on first container creation