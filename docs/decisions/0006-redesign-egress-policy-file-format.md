# ADR 0006: Redesign egress policy file format

- **Status:** Accepted
- **Date:** 2026-05-03
- **Supersedes:** ADR 0005 § Policy file format
- **Implementation:** `src/egress.ts`, `policy.py`, `tests/egress.test.ts`

## Context

ADR 0005 shipped with a hand-rolled line-by-line policy parser:
```
api.github.com: /repos/.*, /users/.*
```

This is fragile:
- No schema validation; malformed files produce garbage silently.
- Patterns are comma-delimited on a single line — awkward for complex policies.
- No support for `DENY` rules (only implicit default-deny).
- No support for method-level control beyond path patterns.
- "Last match wins" is impossible to express — it's always first-match.

The new format should be expressive (multi-rule policies), validated (proper YAML schema), and familiar (iptables-style last-match-wins).

## Decision

Replace the hand-rolled parser with a proper YAML parser (`yaml` npm package, `safeLoad`) and a structured policy format:

```yaml
networkPolicies:
  - host: api.github.com
    policies:
      - action: DENY
        path: /*
        method: *
      - action: ALLOW
        path: /api/someorg/*
        method: *
      - action: DENY
        path: /api/someorg/oneparticularrepo
        method: *
```

### Schema

| Field | Type | Description |
|-------|------|-------------|
| `networkPolicies` | `NetworkPolicy[]` | Top-level array |
| `host` | `string` | Exact hostname to match |
| `policies` | `Rule[]` | Ordered list of allow/deny rules |
| `action` | `"ALLOW" \| "DENY"` | Rule action |
| `path` | `string` | JavaScript-style regex pattern |
| `method` | `string` | HTTP method to match (`GET`, `POST`, `*` for all) |

### Matching semantics

- Rules are evaluated **top-to-bottom** (in declaration order).
- The **last matching rule** wins — like iptables.
- If no rule matches, the request is **DENIED** (default-deny).
- `path` is a regex matched against `flow.request.path`.
- `method` is either `*` (match all) or an exact uppercase method.

### TypeScript interface

```typescript
interface EgressPolicy {
  networkPolicies: NetworkPolicy[];
}

interface NetworkPolicy {
  host: string;
  policies: Rule[];
}

interface Rule {
  action: "ALLOW" | "DENY";
  path: string;
  method: string;
}
```

## Consequences

**Positive**

- Schema validation catches typos and malformed files at startup, before containers start.
- Last-match-wins enables expressive policies like "allow all of GitHub, deny this one repo".
- Method-level control allows `GET` without `POST/PUT/DELETE`.
- YAML structure is familiar and widely understood.
- Safe-mode YAML parser prevents arbitrary code execution from malicious policy files.

**Negative**

- Existing policy files must be migrated to the new format.
- The `yaml` npm package becomes a dependency.

## Implementation plan

1. Add `yaml` to `package.json` dependencies.
2. Rewrite `parsePolicyFile()` in `src/egress.ts` to use `yaml.load()` (safe mode).
3. Update `validatePolicy()` to use the new schema.
4. Update `policy.py` to parse the new YAML format and implement last-match-wins.
5. Update `examples/github-read-only.yaml` with the new format.
6. Update tests in `tests/egress.test.ts`.
7. Update README.md documentation.

## Alternatives considered

- **JSON format.** More familiar to developers but YAML is more readable for policy files with comments.
- **HCL / Terraform-style.** Overkill for this use case; adds a runtime dependency.
- **TOML.** Less universally known; indentation is more brittle.
- **Hand-rolled parser improvements.** Still fragile, no schema validation, no standard tool support.
