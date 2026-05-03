# Architecture Decision Records

Each file in this directory captures a single architectural decision: the context that forced a choice, what was chosen, the alternatives considered, and the consequences accepted.

These are immutable in spirit. When a decision changes, write a new ADR that supersedes the old one rather than rewriting history.

## Index

| ID | Title | Status |
|----|-------|--------|
| [0001](./0001-containment-via-ephemeral-container.md) | Containment via per-session ephemeral container | Accepted |
| [0002](./0002-mount-host-path-at-same-location.md) | Mount the host working directory at the same absolute path inside the container | Accepted |
| [0003](./0003-non-root-via-custom-image.md) | Non-root execution via a custom image built per host user | Accepted |
| [0004](./0004-fail-closed-with-opt-out.md) | Fail-closed by default, with an explicit `--no-sandbox` opt-out | Accepted |
| [0005](./0005-egress-control-via-mitmproxy-sidecar.md) | Egress control via mitmproxy sidecar | Proposed |

## Format

Every ADR follows the same skeleton:

- **Status** — Accepted, Superseded by ADR-NNNN, Deprecated.
- **Date** — when the decision was made.
- **Context** — the forces in play; what made this a decision and not just a default.
- **Decision** — what we chose.
- **Consequences** — both directions, positive and negative.
- **Alternatives considered** — what we rejected and why.

Keep ADRs short. If you need pages of detail, the decision probably hasn't been made yet — you're still in design.

## When to add an ADR

Add one when you make a choice that:

- has more than one defensible answer,
- you'll forget the reasoning for in three months, or
- a future contributor would otherwise have to reverse-engineer from the code.

If you're routinely tempted to write "we did this because reasons" in a code comment, that's a clue the reasons belong here instead.
