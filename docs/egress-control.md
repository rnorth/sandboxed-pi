# Egress Control

When `--egress-policy <file>` is set, a mitmproxy sidecar container filters all outbound HTTP/HTTPS traffic from the sandbox. Each request is evaluated against a per-host list of ALLOW/DENY rules; unmatched requests and unlisted hosts return `403 Access denied by egress policy`.

## Why a transparent proxy

The sandbox container has unrestricted outbound network access by default. Without egress control, the agent can `curl` anywhere, `git push` to any host, install packages from any registry.

Two approaches exist in the ecosystem, neither sufficient on its own:

- **`HTTP_PROXY` env with a filtering proxy.** Voluntary. Raw-socket clients — most Go binaries, statically compiled tools, anything malicious — ignore it.
- **L3 / L4 egress firewall.** Filters by host or IP, not by HTTP method or path. "All of GitHub or none of GitHub" — too coarse for an agent that legitimately needs `GET /repos/...` but should not have `DELETE /repos/...`.

The solution is mitmproxy as a **sidecar container** sharing a network namespace with the workload, with `iptables` REDIRECT inside that shared netns forcing all TCP 80/443 through the proxy — non-voluntary interception that works against raw-socket clients.

Considered proxy alternatives:

- **`HTTP_PROXY` only.** Rejected: voluntary, trivially bypassed.
- **L3 / L4 egress firewall as primary mechanism.** Rejected: cannot filter on path or method.
- **Envoy with Lua/Wasm filters.** Rejected for v1: more production-grade and heavier; policy authoring is significantly more verbose; cert-handling story is fiddlier.
- **goproxy (Go library).** Rejected: would reinvent the policy engine, audit log, and addon framework that mitmproxy already provides.
- **HTTP Toolkit.** Rejected: aimed at interactive debugging, not headless sidecar deployment.
- **Istio / Linkerd egress.** Rejected: solves mTLS + L7 policy between known service identities; far too heavy for this threat model.
- **In-workload patching (LD_PRELOAD shim, runtime SDK swap).** Rejected: per-language, per-runtime, voluntary in the same way `HTTP_PROXY` is.

## How it works

```
pi --egress-policy policy.yaml
  ├── proxy container starts (NET_ADMIN, mitmproxy + iptables in entrypoint)
  ├── workload container starts with --network container:<proxy>  (shared netns)
  └── iptables REDIRECT inside that netns sends TCP 80/443 to mitmproxy:8080
        (--uid-owner exempts the proxy's own upstream traffic)

tool call → docker exec workload <cmd>
  → kernel redirects sockets to mitmproxy (transparent, ignores HTTP_PROXY)
    → policy evaluation (ALLOW/DENY rules; default-deny → 403)
    → TLS-terminate, re-encrypt to upstream
    → audit log written to /var/log/sandboxed-pi/audit.log
```

The audit log is tailed and printed to stderr (visible in the pi UI as info notifications) as requests are processed.

Components:

- **Proxy image** (`proxy/Dockerfile`) — `mitmproxy/mitmproxy` base, runs as non-root, installs iptables rules in the entrypoint.
- **Policy addon** (`proxy/policy.py`) — loaded with `mitmdump -s`. Evaluates the policy file and writes a structured JSON audit log.
- **Workload container** — unchanged from non-egress sessions, plus (a) trusts the mitmproxy CA via `update-ca-certificates`, (b) launched with `--network container:<proxy>`.
- **Activation** — opt-in via `--egress-policy <file>`. If the proxy fails to come up, the session fails closed — same semantics as [container sandbox fail-closed](./container-sandbox.md#fail-closed).

## Policy file format

```yaml
networkPolicies:
  - host: api.github.com
    policies:
      - action: DENY
        path: /.*
        method: "*"
      - action: ALLOW
        path: /repos/.*
        method: GET
      - action: ALLOW
        path: /users/.*
        method: GET

  - host: registry.npmjs.org
    policies:
      - action: ALLOW
        path: /.*
        method: "*"
```

**Schema:**

| Field | Type | Description |
|-------|------|-------------|
| `networkPolicies` | `NetworkPolicy[]` | Top-level array |
| `host` | `string` | Exact hostname to match |
| `policies` | `Rule[]` | Ordered list of allow/deny rules |
| `action` | `"ALLOW" \| "DENY"` | Rule action |
| `path` | `string` | Python regex (`re` module, `fullmatch`) — matched against the path only, query string excluded |
| `method` | `string` | HTTP method (`GET`, `POST`, `*` for all) |

**Matching semantics:**

- Rules are evaluated **top-to-bottom** (declaration order).
- The **last matching rule** wins — like iptables.
- If no rule matches, the request is **DENIED** (default-deny).
- Hosts not listed in the policy are **DENIED**.

The policy file is parsed at startup (using the `yaml` npm package, safe mode) so malformed files fail before containers start.

Considered policy format alternatives:

- **Hand-rolled line-by-line parser.** Rejected: no schema validation, malformed files fail silently, no DENY support, no method-level control.
- **JSON format.** Workable but less readable; YAML is more natural for policy files with comments.
- **HCL / Terraform-style.** Overkill; adds a runtime dependency.

See [`examples/github-read-only.yaml`](../examples/github-read-only.yaml) for a working example.

## DNS interception

All non-root UDP 53 traffic from the workload is redirected by iptables to
a DNS interceptor running inside the proxy process. The interceptor:

- Forwards all non-AAAA, non-PTR query types to the upstream resolver,
  but only for hostnames in the policy host list.
- Caches the A record IPs returned for each hostname.
- Returns NXDOMAIN for hostnames not in the policy, blocking DNS exfiltration
  via attacker-controlled names.
- Returns NODATA for AAAA queries (IPv6 is blocked at the firewall; NODATA
  causes immediate fallback to A rather than a failed connect attempt).
- Returns NXDOMAIN for PTR queries (reverse-IP names don't fit the policy
  schema).

The cached IP↔hostname bindings are then used by the mitmproxy request hook
to verify that each connection's destination IP was legitimately resolved for
the Host/SNI the workload is presenting (see IP-binding enforcement in Limitations below).

**Audit log tags:** `DNS-ALLOW` and `DNS-DENY` appear alongside the existing
`ALLOW`/`DENY` entries. `DENY` entries from the binding check include a
`"reason": "ip-not-bound-to-host"` field.

## Limitations

- Only HTTP/HTTPS traffic is policy-filtered. All other outbound traffic (non-standard TCP ports, SSH, raw UDP, IPv6) is blocked at the firewall — not passed through unfiltered.
- DNS (UDP 53) is intercepted and filtered: only hostnames in the policy
  may be resolved. All other queries return NXDOMAIN, closing the DNS
  exfiltration side-channel. AAAA queries return NODATA (IPv6 is blocked
  at the firewall). PTR queries are blocked.
- IP-binding enforcement: the destination IP of each proxied connection is
  verified against the IPs the DNS interceptor resolved for the claimed
  Host/SNI. A workload presenting an allowed hostname while connecting to
  an arbitrary IP is denied (`DENY` with `reason: ip-not-bound-to-host`
  in the audit log).
- WebSocket connections are only policy-checked at the initial HTTP upgrade request. Frames sent after the upgrade are not inspected — a workload can use an allowed WebSocket endpoint as an arbitrary data channel.
- Cert-pinned clients fail against the mitmproxy CA. Most things (`gh`, `curl`, Node, Python, JVM) honour the system trust store and work, but statically compiled Go binaries with custom `tls.Config{RootCAs:...}` will fail closed.
- The workload loses its own network namespace; anything it wants to do at the network layer (bind privileged ports, set its own iptables) now conflicts with the proxy.
- IPv6 traffic must be covered by `ip6tables` rules mirroring the `iptables` REDIRECT, or IPv6 must be disabled in the netns. If neither is done, AAAA-resolved traffic bypasses the proxy entirely.
