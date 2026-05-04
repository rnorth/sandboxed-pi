#!/usr/bin/env python3
"""Apply iptables egress rules for the sandboxed-pi proxy sidecar.

Usage: setup_iptables.py <proxy_port>

Creates a SANDBOXED_PI chain in the nat and filter tables (IPv4) and
in ip6tables (IPv6), then wires it into OUTPUT.

Design notes:
  - We use OUTPUT, not PREROUTING, because `-m owner` (used to exempt
    the proxy's own traffic) is only valid for locally-generated packets
    and cannot be evaluated in PREROUTING under iptables-nft.
  - Non-root traffic to ports 80/443 is REDIRECT'd to the proxy.
  - Everything else from non-root is DROP'd so non-HTTP protocols
    (SSH, arbitrary TCP, raw UDP) cannot bypass egress controls.
  - UDP 53 (DNS) is exempted so hostname resolution works; it remains
    a residual side-channel, mitigated in v2.
  - All IPv6 is blocked (no IPv6 proxy support).
"""

import subprocess
import sys


def _run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[iptables] {' '.join(cmd)}: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)


def _ipt(*args: str, check: bool = True) -> None:
    cmd = ["iptables"] + list(args)
    if check:
        _run(cmd)
    else:
        subprocess.run(cmd, capture_output=True)


def _ip6t(*args: str, check: bool = True) -> None:
    cmd = ["ip6tables"] + list(args)
    if check:
        _run(cmd)
    else:
        subprocess.run(cmd, capture_output=True)


def teardown() -> None:
    print("[iptables] Removing rules...", file=sys.stderr)
    subprocess.run(["iptables", "-t", "nat", "-F", "SANDBOXED_PI"], capture_output=True)
    subprocess.run(["iptables", "-t", "filter", "-D", "OUTPUT", "-j", "SANDBOXED_PI"], capture_output=True)
    subprocess.run(["iptables", "-t", "filter", "-F", "SANDBOXED_PI"], capture_output=True)
    subprocess.run(["iptables", "-t", "filter", "-X", "SANDBOXED_PI"], capture_output=True)
    subprocess.run(["ip6tables", "-D", "OUTPUT", "-j", "SANDBOXED_PI"], capture_output=True)
    subprocess.run(["ip6tables", "-F", "SANDBOXED_PI"], capture_output=True)
    subprocess.run(["ip6tables", "-X", "SANDBOXED_PI"], capture_output=True)
    print("[iptables] Rules removed.", file=sys.stderr)


def setup(proxy_port: int) -> None:
    print(f"[iptables] Setting up rules (proxy port {proxy_port})...", file=sys.stderr)

    # NAT: redirect HTTP/HTTPS from non-root through mitmproxy
    _ipt("-t", "nat", "-N", "SANDBOXED_PI", check=False)
    _ipt("-t", "nat", "-F", "SANDBOXED_PI")
    _ipt("-t", "nat", "-A", "OUTPUT", "-j", "SANDBOXED_PI")
    for port in [80, 443]:
        _ipt("-t", "nat", "-A", "SANDBOXED_PI",
             "-p", "tcp", "--dport", str(port),
             "-m", "owner", "!", "--uid-owner", "root",
             "-j", "REDIRECT", "--to-port", str(proxy_port))

    # Filter: block non-root traffic not going through the proxy
    _ipt("-t", "filter", "-N", "SANDBOXED_PI", check=False)
    _ipt("-t", "filter", "-F", "SANDBOXED_PI")
    _ipt("-t", "filter", "-A", "OUTPUT", "-j", "SANDBOXED_PI")
    _ipt("-t", "filter", "-A", "SANDBOXED_PI", "-m", "owner", "--uid-owner", "root", "-j", "RETURN")
    _ipt("-t", "filter", "-A", "SANDBOXED_PI", "-o", "lo", "-j", "RETURN")
    _ipt("-t", "filter", "-A", "SANDBOXED_PI", "-p", "udp", "--dport", "53", "-j", "RETURN")
    _ipt("-t", "filter", "-A", "SANDBOXED_PI", "-j", "DROP")

    # IPv6: block all non-root outbound
    _ip6t("-N", "SANDBOXED_PI", check=False)
    _ip6t("-F", "SANDBOXED_PI")
    _ip6t("-A", "OUTPUT", "-j", "SANDBOXED_PI")
    _ip6t("-A", "SANDBOXED_PI", "-m", "owner", "--uid-owner", "root", "-j", "RETURN")
    _ip6t("-A", "SANDBOXED_PI", "-o", "lo", "-j", "RETURN")
    _ip6t("-A", "SANDBOXED_PI", "-j", "DROP")

    print("[iptables] Rules installed.", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <proxy_port>", file=sys.stderr)
        sys.exit(1)
    setup(int(sys.argv[1]))
