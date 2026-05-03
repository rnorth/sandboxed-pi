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
   # Comments start with #
   # host: pattern1, pattern2, ...
   
   api.github.com: /repos/.*, /users/.*
   registry.npmjs.org: /.*
   ```

2. Test it with `pi --egress-policy ./your-policy.yaml`

3. Watch the audit log for blocked requests (printed to stderr or visible in the pi UI):

   ```
   [sandboxed-pi] [egress] {"timestamp":"...","decision":"ALLOW","host":"api.github.com","path":"/repos/..."}
   [sandboxed-pi] [egress] {"timestamp":"...","decision":"DENY","host":"evil.example.com","path":"/..."}
   ```

### Pattern tips

- Patterns are **JavaScript-style regexes** (used by both the Node.js validator and mitmproxy's Python `re` module).
- `.*` matches any characters (including none).
- `/api/v[0-9]+/.*` matches `/api/v1/foo`, `/api/v123/bar`, etc.
- `[^/]+` matches one or more non-slash characters.
- Test your patterns with [regex101.com](https://regex101.com/) using JavaScript flavor.

### Security notes

- **Default-deny:** Any host+path not explicitly listed is blocked (returns 403).
- **DNS is not intercepted:** Workloads can still resolve hostnames. Only HTTP/HTTPS traffic is filtered.
- **IPv6 is not intercepted:** Only IPv4 iptables rules are set up.
- **Cert-pinned clients:** Clients that pin TLS certificates will fail when mitmproxy intercepts their traffic.