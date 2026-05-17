# enclave: Architecture

`enclave` runs a user-supplied program inside an ephemeral Docker container. The entire program lives in the container — there is no host-side tool interception. This document is a high-level orientation; each feature has its own doc.

## Philosophy

**Containment, not just isolation.** Every subprocess your program spawns runs inside the container.

**Fail-closed.** Missing config, missing Docker, or missing `networkPolicies` all produce a clear error or warning rather than silently degrading.

**Generic.** No coupling to any specific wrapped tool.

## Invocation overview

```
enclave -- pi
  ├── load + validate ~/.config/enclave/config.yaml
  ├── warn if no networkPolicies (default-deny in effect)
  ├── build curated base image if missing (cached as enclave-base:dev)
  ├── build per-user image on top (cached as enclave-<user>:<uid>)
  ├── docker create workload (cwd mounted, --user UID:GID)
  ├── docker create proxy (NET_ADMIN, shared netns, in-memory policy)
  ├── install proxy CA cert in workload, start audit-log tail → stderr
  ├── docker exec -it workload <program> <args>   ← user interacts here
  └── (on exit) tear down proxy then workload, propagate exit code
```

## Feature docs

- **[Configuration](./container-configuration.md)** — config file schema, cwd mount, environment overrides
- **[Container image](./container-image.md)** — curated tool set, mise integration, two-stage image build, bring-your-own-base contract
- **[Container sandbox](./container-sandbox.md)** — containment model, fail-closed behaviour, sandbox-bypass risks
- **[Egress control](./egress-control.md)** — mitmproxy sidecar, policy format, limitations
