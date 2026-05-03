# sandboxed-pi — Implementation Plan

## Files and structure

```
~/.pi/agent/extensions/sandboxed-pi/
├── package.json
├── index.ts             # Main extension entry point
├── docker.ts            # Container lifecycle and low-level docker exec helper
└── ops.ts               # Docker-based ReadOperations, WriteOperations, etc.
```

Also mirrored in this project directory (`sandboxed-pi/` subdirectory) for dev tracking.

## Architecture

### Extension lifecycle

1. **Factory function** — Registers `--sandbox-image` flag, no heavy work yet. Sets up tool overrides lazily.

2. **`session_start`** — Resolves the container image from flags/config. Pulls image if needed. Creates a Docker container (`docker run -d`) with `pwd` mounted rw at the same absolute path. Stores container name in closure.

3. **Tool calls** — Each overridden tool delegates to `createXxxTool(localCwd, { operations: dockerOps })`. The Docker ops translate every filesystem operation into a `docker exec` call.

4. **`user_bash`** — Returns custom `BashOperations` for `!` / `!!` commands.

5. **`session_shutdown`** — `docker rm -f <container>`.

6. **`before_agent_start`** — Patches the system prompt's `cwd` line to indicate containerization.

### Container

```bash
# Created on session_start:
docker run -d --rm                                           \
  --name pi-sandboxed-<random>                                \
  -v /host/pwd:/host/pwd:rw                                  \
  <image>                                                     \
  sleep infinity
```

- `--rm` for automatic cleanup if container crashes
- Mount at same path on host and in container → no path translation needed
- `sleep infinity` keeps container alive

### Docker exec patterns

```typescript
// Bash
docker exec -i -w <cwd> <container> bash -c "<command>"

// Read file
docker exec <container> cat <path>

// Check access
docker exec <container> test -r <path>

// Write file
docker exec -i <container> bash -c "mkdir -p $(dirname <path>) && cat > <path>"
  → pipe content to stdin

// Create directory
docker exec <container> mkdir -p <path>

// Stat file
docker exec <container> stat <path> --format="%F"

// List directory
docker exec <container> ls -1 <path>

// Glob (find)
docker exec <container> find <cwd> -name "<pattern>" -type f

// MIME type detection
docker exec <container> file --mime-type -b <path>
```

### Tool operations mapping

| Built-in tool | Operations impl | How |
|---|---|---|
| `bash` | `BashOperations.exec()` | `docker exec -i -w <cwd> <ctr> bash -c <cmd>`, stream stdout/stderr via onData |
| `read` | `ReadOperations.readFile()` | `docker exec <ctr> cat <path>`, capture Buffer |
| | `.access()` | `docker exec <ctr> test -r <path>` |
| | `.detectImageMimeType()` | `docker exec <ctr> file --mime-type -b <path>`, parse output |
| `write` | `WriteOperations.writeFile()` | `docker exec -i <ctr> bash -c "mkdir -p ... && cat > <path>"`, pipe content as stdin |
| | `.mkdir()` | `docker exec <ctr> mkdir -p <path>` |
| `edit` | `EditOperations.readFile()` | reuses read ops |
| | `.writeFile()` | reuses write ops |
| | `.access()` | reuses read ops |
| `ls` | `LsOperations.exists()` | `docker exec <ctr> test -e <path>` |
| | `.stat()` | `docker exec <ctr> stat <path>` → parse |
| | `.readdir()` | `docker exec <ctr> ls -1 <path>` → split |
| `grep` | `GrepOperations.isDirectory()` | `docker exec <ctr> test -d <path>` |
| | `.readFile()` | `docker exec <ctr> cat <path>` |
| `find` | `FindOperations.exists()` | `docker exec <ctr> test -e <path>` |
| | `.glob()` | `docker exec <ctr> find <cwd> -type f -name <pattern>` |

### Error handling

- Container not running → auto-restart (attempt `docker start`, fall back to recreating)
- Path outside mounted volume → Docker error propagates naturally
- Timeouts → kill `docker exec` process group
- `AbortSignal` → kill `docker exec` process group

### Edge cases

- **Detached container crash**: Check container status before exec; restart if dead
- **Large file writes**: Stream via stdin (piped to `cat > <path>`), avoid argument limits
- **Special characters in paths**: Shell-escape with JSON.stringify or single quotes
- **Mac → Linux path semantics**: Mounts at same absolute path, path translation not needed
- **Container name collisions**: Use random suffix (crypto.randomUUID)
