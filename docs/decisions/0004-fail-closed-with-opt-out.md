# ADR 0004: Fail-closed by default, with an explicit `--no-sandbox` opt-out

- **Status:** Accepted
- **Date:** 2026-05-03

## Context

The whole point of this extension is that tool execution does **not** touch the host. A silent fallback — "Docker isn't available, run on the host instead" — defeats that promise without telling the user. They'd believe they were sandboxed when they weren't.

But absolutism has costs too:

- Docker may genuinely be unavailable on a given machine, and the user may want to keep using pi without it.
- During development of the extension itself, container startup may fail and the user may want to keep working.
- Some tasks are obviously safe (reading a doc, running `git log`) and the user may want to opt out for a specific session.

The design needs to give the user a deliberate way to opt out, while never doing so automatically.

## Decision

Two states, chosen by the user at session start via the `--no-sandbox` flag:

| `--no-sandbox` | Docker reachable | Behavior |
|----------------|------------------|----------|
| not set        | yes              | Containerized execution. Tools route through `docker exec`. |
| not set        | no               | **Fail at session_start.** Tools must not silently run on the host. |
| set            | (irrelevant)     | Local execution. The user has explicitly opted out; pi behaves as if the extension weren't installed. |

The flag is the **only** path to local execution. There is no environment variable, no config-file fallback, no auto-degradation.

When the user opts out, the UI surfaces a warning ("Container sandbox disabled via --no-sandbox") so the state is visible — opting out is a deliberate, observable act.

## Consequences

**Positive**

- The security guarantee is binary and predictable: if pi started without warning, tools are containerized.
- The flag is visible in the user's shell history and in the running command, so it's auditable.
- No spooky-action-at-a-distance: a transient Docker hiccup doesn't quietly downgrade safety mid-session.

**Negative**

- A user who hits a Docker problem mid-startup has to either fix Docker or restart with `--no-sandbox`. There is no "just keep going" path.
- Users have to learn one more flag.

## Alternatives considered

- **Auto-fallback on Docker unavailability.** Rejected: violates the security guarantee silently. The whole reason the extension exists is to *not* run on the host.
- **Prompt the user interactively when Docker is unavailable.** Rejected: pi sessions may be non-interactive (CI, scripted), and an interactive prompt is fragile compared to an explicit flag.
- **Treat `--no-sandbox` as a degrade-at-runtime hint.** Rejected: makes the runtime behavior depend on whether Docker came up, which is exactly the unpredictability we want to avoid.
