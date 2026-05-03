#!/usr/bin/env python3
"""
mitmproxy policy addon for sandboxed-pi.
Implements host+path allowlist enforcement and structured audit logging.

Usage:
    mitmdump -s policy.py /path/to/policy.yaml

Policy file format (YAML-like):
    example.com:
        - /api/v.*/repos/.*
        - /users/[^/]+/gists
    api.github.com:
        - /repos/.*
        - /user

Each line is: host: [pattern1, pattern2, ...]
Lines starting with # are comments.
"""

import sys
import re
import json
from datetime import datetime
from typing import Optional

from mitmproxy import http, ctx


class PolicyAddon:
    """mitmproxy addon that enforces an allowlist on HTTP requests."""

    def __init__(self, policy_file: str):
        self.policy_file = policy_file
        self.allowlist: dict[str, list[re.Pattern]] = {}
        self.audit_log_path = "/var/log/sandboxed-pi/audit.log"
        self._load_policy()

    def _load_policy(self) -> None:
        """Load policy from file, compiling regex patterns."""
        self.allowlist = {}
        try:
            with open(self.policy_file, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue

                    # Parse "host: [pattern, pattern]"
                    colon_idx = line.find(":")
                    if colon_idx == -1:
                        continue

                    host = line[:colon_idx].strip()
                    # Use [colon_idx + 1:] (with colon) — not [colon_idx + 1] (single char).
                    patterns_raw = line[colon_idx + 1:].strip()

                    # Remove surrounding brackets
                    patterns_raw = patterns_raw.lstrip("[")
                    patterns_raw = patterns_raw.rstrip("]").rstrip(",")

                    patterns = []
                    for p in patterns_raw.split(","):
                        p = p.strip().strip('"').strip("'")
                        if p:
                            patterns.append(re.compile(p))

                    if patterns:
                        self.allowlist[host] = patterns

            ctx.log.info(f"Loaded policy with {len(self.allowlist)} hosts")
        except Exception as e:
            ctx.log.error(f"Failed to load policy file: {e}")
            raise

    def _audit(self, decision: str, host: str, path: str, method: str) -> None:
        """Write a structured audit log entry."""
        entry = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "decision": decision,
            "host": host,
            "path": path,
            "method": method,
        }
        try:
            with open(self.audit_log_path, "a") as f:
                f.write(json.dumps(entry) + "\n")
            # Also log to mitmproxy's log for visibility
            ctx.log.warn(f"AUDIT: {decision} {method} {host}{path}")
        except Exception as e:
            ctx.log.error(f"Failed to write audit log: {e}")

    def request(self, flow: http.HTTPFlow) -> None:
        """Handle request — do allowlist check after headers are loaded."""
        # mitmproxy has already parsed the request
        host = flow.request.pretty_host
        path = flow.request.path
        method = flow.request.method

        # Check allowlist
        allowed = self._check_allowlist(host, path)

        if not allowed:
            # Block the request
            flow.response = http.Response.make(
                403,
                b"Access denied by egress policy",
                {"Content-Type": "text/plain"},
            )
            self._audit("DENY", host, path, method)
        else:
            self._audit("ALLOW", host, path, method)

    def _check_allowlist(self, host: str, path: str) -> bool:
        """Check if host+path matches any allowlisted pattern."""
        patterns = self.allowlist.get(host, [])
        if not patterns:
            # No allowlist entry for this host — block by default
            return False

        for pattern in patterns:
            if pattern.search(path):
                return True

        return False


def start():
    """Entry point called by mitmdump -s."""
    if len(sys.argv) < 2:
        print("Usage: policy.py <policy_file>", file=sys.stderr)
        sys.exit(1)

    policy_file = sys.argv[1]
    addon = PolicyAddon(policy_file)
    return addon


# mitmdump loads the addon via this addon's path, calling start()
addons = [start()]