# Proxy Image Publishing Design

**Date:** 2026-05-06  
**Status:** Approved

## Summary

Publish the egress proxy Docker image to `ghcr.io/rnorth/sandboxed-pi/proxy` via GitHub Actions, and update the extension to pull the published image instead of building locally.

## GitHub Actions Workflow

File: `.github/workflows/publish-proxy.yml`

**Triggers:**
- Push to `main` with path filter `proxy/**`
- Git tags matching `v*`

**Steps:** checkout → Docker Buildx setup → ghcr.io login (via `GITHUB_TOKEN`) → build and push via `docker/build-push-action` + `docker/metadata-action`

**Tag strategy:**
- Push to `main`: `:latest` + `:<git-sha>`
- Push of `v0.1.0` tag: `:0.1.0` + `:latest` + `:<git-sha>` (version strips the `v` prefix via `type=semver,pattern={{version}}`)

## Changes to `egress.ts`

Replace `ensureProxyImageExists()` with `resolveProxyImage(proxyImage?: string)`:

- If `proxyImage` is provided (via `--proxy-image` flag): return it as-is, no pull
- Otherwise: read version from `package.json`, pull `ghcr.io/rnorth/sandboxed-pi/proxy:<version>`, fail-fast on error

Remove all local-build logic: `PROXY_IMAGE_NAME_PREFIX`, `readFileSync` of Dockerfile, `docker build` call.

## New `--proxy-image` Flag

Add `--proxy-image <image>` flag in `index.ts` (parallel to existing `--sandbox-image`). Passed through to the egress container startup path. Intended for development use — point at a locally built image when the published version doesn't exist yet.

## Docs and Tests

- `README.md` configuration table: add `--proxy-image` row (type: string, default: pulls `ghcr.io/rnorth/sandboxed-pi/proxy:<version>`, description: use a pre-built local proxy image, for development)
- Unit tests: replace `ensureProxyImageExists` tests with `resolveProxyImage` tests covering:
  - Explicit image override returns the override directly
  - Successful pull returns the versioned ghcr.io image name
  - Pull failure throws (fail-fast, no fallback)
