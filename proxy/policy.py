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
    - Only TCP 80/443 is intercepted and policy-filtered. All other outbound
      traffic is blocked by iptables DROP rules in the sidecar entrypoint.
    - WebSocket connections: only the initial HTTP upgrade request is checked
      by this addon. Frames after the upgrade are not inspected — mitmproxy
      exposes them via websocket_message(), which this addon does not implement.
"""

import ipaddress
import os
import re
import sys
import json
import threading
from datetime import datetime
from typing import Optional

import yaml
from mitmproxy import http, ctx

from dns_interceptor import BindingCache, DnsInterceptor


def _is_ip_address(s: str) -> bool:
    try:
        ipaddress.ip_address(s)
        return True
    except ValueError:
        return False


def _check_binding(host: str, dest_ip: Optional[str], cache: BindingCache) -> bool:
    """Return True if the connection should be allowed through the binding check.

    Returns True (skip check) when dest_ip is None or a hostname — mitmproxy
    resolved it, so it wasn't an arbitrary IP connection.
    Returns True when dest_ip is an IP that was recorded for host in cache.
    Returns False (deny) when dest_ip is an IP not recorded for host.
    """
    if dest_ip is None or not _is_ip_address(dest_ip):
        return True
    return cache.is_bound(host, dest_ip)


class PolicyAddon:
    """mitmproxy addon that enforces an allowlist on HTTP requests."""

    def __init__(self):
        self.policy_file = ""
        self.network_policies: list[dict] = []
        self._audit_log_path = "/var/log/sandboxed-pi/audit.log"
        self._allowed_hosts: frozenset = frozenset()
        self._binding_cache: BindingCache = BindingCache()
        self._audit_lock: threading.Lock = threading.Lock()
        self._dns_interceptor: Optional[DnsInterceptor] = None

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

            self._allowed_hosts = frozenset(
                entry["host"] for entry in content.get("networkPolicies", [])
            )

            ctx.log.info(f"Loaded policy with {len(self.network_policies)} hosts")

        except Exception as e:
            ctx.log.error(f"Failed to load policy file: {e}")
            raise

    def _audit(self, decision: str, host: str, path: str, method: str, reason: Optional[str] = None) -> None:
        """Write a structured audit log entry."""
        entry = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "decision": decision,
            "host": host,
            "path": path,
            "method": method,
        }
        if reason is not None:
            entry["reason"] = reason
        try:
            with self._audit_lock:
                with open(self._audit_log_path, "a") as f:
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

        # IP-binding check: verify dest IP was resolved by our DNS interceptor
        dest_ip = flow.server_conn.address[0] if flow.server_conn.address else None
        if not _check_binding(host, dest_ip, self._binding_cache):
            self._audit("DENY", host, path, method, reason="ip-not-bound-to-host")
            flow.response = http.Response.make(
                403, b"Access denied by egress policy", {"Content-Type": "text/plain"}
            )
            return

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

    def running(self) -> None:
        """Called by mitmproxy when the proxy is fully up and ready."""
        self._dns_interceptor = DnsInterceptor(
            allowed_hosts=self._allowed_hosts,
            cache=self._binding_cache,
            audit_log_path=self._audit_log_path,
            audit_lock=self._audit_lock,
        )
        self._dns_interceptor.start()
        if not self._allowed_hosts:
            ctx.log.warn("[sandboxed-pi] DNS interceptor started with empty allowlist — all DNS queries will return NXDOMAIN")
        threading.Thread(
            target=self._dns_watchdog,
            daemon=True,
            name="dns-watchdog",
        ).start()

    def _dns_watchdog(self) -> None:
        if self._dns_interceptor is None:
            return
        self._dns_interceptor.join()
        # DNS interceptor thread died unexpectedly — fail closed
        print("[sandboxed-pi] DNS interceptor thread died, shutting down", file=sys.stderr)
        os._exit(1)

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
