# Egress policy examples

This directory contains example policy files for the `--egress-policy` flag.

## github-read-only.yaml

Allows read-only access to GitHub's API (repos, users, gists, etc.) and npm package downloads. Blocks all other outbound HTTP/HTTPS traffic.

**Use case:** An agent that should only be able to read code and install npm packages, but cannot push, delete, or call arbitrary APIs.

```bash
pi --egress-policy ./examples/github-read-only.yaml
```

## Creating your own policy

1. Create a YAML file following the format:

   ```yaml
   networkPolicies:
     - host: example.com
       policies:
         - action: DENY
           path: /.*
           method: "*"
         - action: ALLOW
           path: /api/v1/.*
           method: GET
   ```

2. Test it with `pi --egress-policy ./your-policy.yaml`

3. Watch the audit log for blocked requests (printed to stderr or visible in the pi UI):

   ```
   [sandboxed-pi] [egress] {"timestamp":"...","decision":"ALLOW","host":"api.github.com","path":"/repos/..."}
   [sandboxed-pi] [egress] {"timestamp":"...","decision":"DENY","host":"evil.example.com","path":"/..."}
   ```

### Pattern tips

- Patterns are **Python regexes** (the `re` module). Enforcement uses `fullmatch()`, so the pattern must match the entire path — use `/repos/.*` not `/repos/` (no trailing wildcard means exact match).
- Query strings are stripped before matching: a rule for `/api/v1/.*` will match `/api/v1/foo?bar=baz`.
- `.*` matches any characters (including none).
- `/api/v[0-9]+/.*` matches `/api/v1/foo`, `/api/v123/bar`, etc.
- `[^/]+` matches one or more non-slash characters.
- Test your patterns with [regex101.com](https://regex101.com/) using the Python flavor.

### Security notes

- **Default-deny:** Any host+path not explicitly listed is blocked (returns 403).
- **DNS is not intercepted:** Workloads can still resolve hostnames. Only HTTP/HTTPS traffic is filtered.
- **IPv6 is not intercepted:** Only IPv4 iptables rules are set up.
- **WebSocket frames are not policy-checked:** Only the initial HTTP upgrade request is evaluated. Once a WebSocket connection is established to an allowed path, subsequent frames bypass policy enforcement.
- **Cert-pinned clients:** Clients that pin TLS certificates will fail when mitmproxy intercepts their traffic.