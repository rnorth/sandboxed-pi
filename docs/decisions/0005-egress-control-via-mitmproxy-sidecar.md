# ADR 0005: Egress control via mitmproxy sidecar

- **Status:** Proposed
- **Date:** 2026-05-03
- **Tracking issue:** [#1](https://github.com/rnorth/sandboxed-pi/issues/1)

## Context

The sandbox container has unrestricted outbound network access. [architecture.md § Security guarantees and limits](../architecture.md#security-guarantees-and-limits) flags this explicitly: the agent can `curl` anywhere, `git push` to any host, install packages from any registry. For a containment-focused tool this is a meaningful gap.

For workloads we don't fully trust — LLM agents, vendor CLIs, jobs that legitimately need to talk to specific external APIs — three options exist in the ecosystem, none of them sufficient on their own:

- **`HTTP_PROXY` env with a filtering proxy.** Voluntary. Raw-socket clients — most Go tools, anything statically compiled, anything malicious — ignore it.
- **L3 / L4 egress firewall.** Filters by host or IP, not by HTTP method or path. "All of GitHub or none of GitHub" — too coarse for an agent that legitimately needs `GET /repos/...` but should not have `DELETE /repos/...`.
- **L7 forward proxy.** Path- and method-aware, but only useful if non-voluntary.

We additionally want the agent to **never hold real credentials**. If the workload only ever sees a `TOKENIZED_*` placeholder, then a leaked log, a prompt-injection exfiltration attempt, or a stray `echo $GITHUB_TOKEN` reveals nothing useful.

## Decision

Run **mitmproxy as a sidecar container** sharing a network namespace with the workload, with `iptables` REDIRECT inside that shared netns forcing all TCP 80/443 through the proxy. The proxy enforces a host+path allowlist and substitutes tokenized placeholders for real secrets.

```
session_start
  ├── proxy container starts (NET_ADMIN, mitmproxy + iptables in entrypoint)
  ├── workload container starts with `--network container:<proxy>`  (shared netns)
  └── iptables REDIRECT inside that netns sends TCP 80/443 to mitmproxy:8080
        (`--uid-owner` exempts the proxy's own upstream traffic)

tool call → docker exec workload <cmd>
  → kernel redirects sockets to mitmproxy (transparent, ignores HTTP_PROXY)
    → allowlist check (host + path regex; default-deny → 403)
    → token substitution: TOKENIZED_X → real secret, audit-log
    → TLS-terminate, re-encrypt to upstream
```

Pieces:

- **Proxy image** — `mitmproxy/mitmproxy` base, runs as non-root, installs iptables rules in the entrypoint.
- **Policy file** (`policy.yaml`) — host + path-regex allowlist, default-deny, list of token placeholders. Hand-rolled YAML; no UI for v1.
- **Addon** (`policy.py`) — ~50 lines, loaded with `mitmdump -s`. Implements the allowlist, token substitution, and a structured JSON audit log to stdout.
- **Workload container** — unchanged from today, plus (a) trusts the mitmproxy CA via a per-base-image snippet, (b) real secrets replaced with `TOKENIZED_*` placeholders in env, (c) launched with `--network container:<proxy>`.
- **Activation** — opt-in via a new flag (e.g. `--egress-policy <file>`). When set, follows [ADR 0004](./0004-fail-closed-with-opt-out.md) semantics: if the proxy fails to come up, the session fails closed. Without the flag, behaviour is unchanged from today.

Token substitution is part of the decision, not an add-on. A path-aware egress filter that still hands real credentials to the workload solves only half the problem.

## Consequences

**Positive**

- Egress filtering is non-voluntary: works against tools that ignore `HTTP_PROXY`, including raw-socket binaries.
- Real credentials never enter the workload's environment. Prompt-injection / log-leak exfiltration of the GitHub token, npm token, etc. becomes a non-event.
- Path- and method-level granularity: `GET /repos/...` allowed, `DELETE /repos/...` denied.
- Structured audit log of every request and policy decision falls out for free.

**Negative**

- New hard dependency on the proxy. A proxy crash takes the workload's network with it; container resilience ([architecture.md § Container resilience](../architecture.md#container-resilience)) gets more complex.
- Cert-pinned clients (Go binaries with custom `tls.Config{RootCAs:...}`) fail closed against the substituted CA. Most things — `gh`, `curl`, Node, Python, JVM — honour the system trust store and work, but this is a surprise to document.
- CA-trust install differs per language: `update-ca-certificates`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`, JVM keystore. `Dockerfile.template` becomes more opinionated, with a per-base-image snippet.
- IPv6 must be mirrored with `ip6tables` or disabled in the netns; forgetting this leaks AAAA-resolved traffic unintercepted.
- DNS over UDP/53 is a residual side channel unless we additionally run a resolver in the sidecar and DROP outbound 53 — see open questions.
- The workload loses its own network namespace; anything it wants to do at the network layer (bind privileged ports, set its own iptables) now conflicts with the proxy.
- Image-pull and startup costs grow: a second image, a second container per session.

## Alternatives considered

- **`HTTP_PROXY` only.** Rejected: voluntary, trivially bypassed.
- **L3 / L4 egress firewall as the primary mechanism.** Rejected: cannot filter on path or method. Could complement an L7 proxy but is the wrong primary tool for this threat model.
- **Envoy with Lua/Wasm filters.** Rejected for v1: more production-grade and heavier; policy authoring is significantly more verbose; cert-handling story is fiddlier. Revisit if this needs to scale across many workloads.
- **goproxy (Go library).** Rejected: a single static binary is appealing, but we'd reinvent the policy engine, audit log, and addon framework that mitmproxy already provides.
- **HTTP Toolkit.** Rejected: aimed at interactive debugging, not headless sidecar deployment.
- **Istio / Linkerd egress.** Rejected: solves mTLS + L7 policy between known service identities, doesn't do token substitution, far too heavy for our threat model.
- **In-workload patching (LD_PRELOAD shim, runtime SDK swap).** Rejected: per-language, per-runtime, voluntary in the same way `HTTP_PROXY` is.

## Open questions (defer to implementation)

- **Secret source at proxy startup.** Env vars are fine for v1; production-style use wants Vault / cloud metadata / a file-mounted secret manager.
- **DNS strategy.** Accept the UDP/53 side channel, or run a resolver in the sidecar and DROP outbound 53? Tied to the threat-model commitment.
- **Multi-tenant token table.** One workload may need GitHub + npm + internal-API tokens at once. Policy schema must handle this without becoming unwieldy.
- **WebSocket / SSE.** mitmproxy supports both but addon hooks differ. Defer for v1.
- **k8s deployment.** The `--network container:<proxy>` pattern translates to a sidecar + initContainer setting up iptables in the pod netns. Separate spike.
- **Streaming responses.** mitmproxy buffers in `response()` by default. Move to streaming hooks if it bites us; not relevant for typical API calls.

## Out of scope (v1)

- Non-HTTP protocols.
- Per-request rate limiting.
- Web UI for policy authoring.
- Mutual TLS to upstreams.
