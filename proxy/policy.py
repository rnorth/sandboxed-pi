#!/usr/bin/env python3
"""
mitmproxy policy addon for sandboxed-pi.
Implements host+path allowlist enforcement and structured audit logging.

Usage:
    mitmdump -s /usr/local/bin/policy.py --set policy_file=/path/to/policy.yaml

Policy file format (YAML):
    networkPolicies:
      - host: api.github.com
        policies:
          - action: DENY
            path: /.*
            method: "*"
          - action: ALLOW
            path: /api/someorg/.*
            method: "*"
          - action: DENY
            path: /api/someorg/oneparticularrepo
            method: "*"

Matching semantics:
    - Rules are evaluated top-to-bottom (in declaration order).
    - The last matching rule wins (like iptables).
    - If no rule matches, the request is DENIED (default-deny).
    - path is a Python regex (re module) matched with fullmatch() against the
      path component only (query string is stripped before matching).
    - method is either '*' (match all) or an exact uppercase HTTP method.

Known limitations:
    - Host matching uses SNI (HTTPS) or the Host header (HTTP), both of which
      are workload-controlled. A workload can direct a TCP connection to an
      arbitrary IP while presenting an allowed SNI/Host, bypassing the hostname
      check. Full mitigation requires DNS interception (deferred to v2).
    - Only TCP 80/443 is intercepted and policy-filtered. All other outbound
      traffic is blocked by iptables DROP rules in the sidecar entrypoint.
    - WebSocket connections: only the initial HTTP upgrade request is checked
      by this addon. Frames after the upgrade are not inspected — mitmproxy
      exposes them via websocket_message(), which this addon does not implement.
"""

import re
import json
from datetime import datetime
from typing import Optional

import yaml
from mitmproxy import http, ctx


class PolicyAddon:
    """mitmproxy addon that enforces an allowlist on HTTP requests."""

    def __init__(self):
        self.policy_file = ""
        self.network_policies: list[dict] = []
        self.audit_log_path = "/var/log/sandboxed-pi/audit.log"

    def load(self, loader) -> None:
        loader.add_option(
            name="policy_file",
            typespec=str,
            default="",
            help="Path to the egress policy YAML file",
        )

    def configure(self, updates) -> None:
        if "policy_file" in updates:
            self.policy_file = ctx.options.policy_file
            if self.policy_file:
                self._load_policy()

    def _load_policy(self) -> None:
        """Load policy from YAML file, compiling regex patterns."""
        self.network_policies = []
        try:
            with open(self.policy_file, "r") as f:
                content = yaml.safe_load(f)

            if not content or "networkPolicies" not in content:
                ctx.log.error("Policy file must contain 'networkPolicies' key")
                return

            for entry in content["networkPolicies"]:
                host = entry.get("host", "")
                policies = entry.get("policies", [])

                if not host or not isinstance(policies, list):
                    continue

                compiled_rules = []
                for rule in policies:
                    action = rule.get("action", "")
                    path = rule.get("path", "")
                    method = rule.get("method", "")

                    if action not in ("ALLOW", "DENY"):
                        continue
                    if not path or not method:
                        continue

                    try:
                        compiled_path = re.compile(path)
                        compiled_rules.append({
                            "action": action,
                            "path": compiled_path,
                            "method": method,
                        })
                    except re.error as e:
                        ctx.log.error(f"Invalid regex pattern '{path}': {e}")

                if compiled_rules:
                    self.network_policies.append({
                        "host": host,
                        "rules": compiled_rules,
                    })

            ctx.log.info(f"Loaded policy with {len(self.network_policies)} hosts")

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
        host = flow.request.pretty_host
        # Strip query string — policy rules match only the path component.
        path = flow.request.path.split("?")[0]
        method = flow.request.method

        # Check policies
        decision = self._check_policy(host, path, method)

        if not decision:
            # No matching rule — deny by default
            flow.response = http.Response.make(
                403,
                b"Access denied by egress policy",
                {"Content-Type": "text/plain"},
            )
            self._audit("DENY", host, path, method)
        elif decision == "DENY":
            flow.response = http.Response.make(
                403,
                b"Access denied by egress policy",
                {"Content-Type": "text/plain"},
            )
            self._audit("DENY", host, path, method)
        else:
            self._audit("ALLOW", host, path, method)

    def _check_policy(self, host: str, path: str, method: str) -> Optional[str]:
        """Check if host+path+method matches any policy rule.

        Returns:
            - "ALLOW" if the last matching rule is ALLOW
            - "DENY" if the last matching rule is DENY
            - None if no rule matches (default-deny)
        """
        last_match: Optional[str] = None

        for np in self.network_policies:
            if np["host"] != host:
                continue

            for rule in np["rules"]:
                if rule["method"] != "*" and rule["method"] != method:
                    continue
                if rule["path"].fullmatch(path):
                    last_match = rule["action"]

        return last_match


addons = [PolicyAddon()]
