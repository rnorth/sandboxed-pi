#!/usr/bin/env python3
"""Entrypoint for the sandboxed-pi egress proxy container.

Sequence:
  1. Wait for the shared network namespace to be ready.
  2. Apply iptables egress rules (via setup_iptables).
  3. Pre-generate the mitmproxy CA certificate.
  4. Write the ready marker so the TS host knows setup is complete.
  5. Run mitmdump as a child process, forwarding signals.
  6. On exit, tear down iptables rules.

Running mitmdump as a child (rather than os.execvp) keeps Python as
PID 1 so that SIGTERM from Docker is caught here, forwarded to
mitmdump, and cleanup runs after mitmdump exits.
"""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import setup_iptables  # noqa: E402 — path manipulation required above


POLICY_FILE = sys.argv[1] if len(sys.argv) > 1 else "/etc/sandboxed-pi/policy.yaml"
PROXY_PORT = 8080
MARKER_FILE = Path("/var/run/sandboxed-pi/proxy-ready")
CERT_DIR = "/root/.mitmproxy"
CERT_FILE = Path(CERT_DIR) / "mitmproxy-ca-cert.pem"


def log(msg: str) -> None:
    print(f"[entrypoint] {msg}", file=sys.stderr)


def wait_for_network(retries: int = 10) -> None:
    log("Waiting for network...")
    for _ in range(retries):
        if subprocess.run(["ip", "addr", "show"], capture_output=True).returncode == 0:
            log("Network ready.")
            return
        time.sleep(0.5)
    log("Warning: network not ready, proceeding anyway.")


def generate_ca_cert(retries: int = 10) -> None:
    log(f"Checking for CA cert at {CERT_FILE}...")
    if CERT_FILE.exists():
        log("CA cert already exists, skipping generation.")
        return

    log(f"Generating CA cert (up to {retries} attempts)...")
    for attempt in range(retries, 0, -1):
        log(f"CA cert attempt {attempt} remaining...")
        if CERT_FILE.exists():
            log("CA cert generated.")
            return
        proc = subprocess.Popen(
            ["mitmdump", "--set", f"confdir={CERT_DIR}", "--no-server"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(3)
        proc.terminate()
        try:
            proc.wait(timeout=7)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    log(f"Warning: CA cert not found at {CERT_FILE} after retries.")


def main() -> None:
    log(f"Starting setup. Policy file: {POLICY_FILE}")

    wait_for_network()

    subprocess.run(["sysctl", "-w", "net.ipv4.ip_forward=1"], capture_output=True)
    setup_iptables.setup(PROXY_PORT)

    generate_ca_cert()

    MARKER_FILE.write_text("ready\n")
    log("Ready marker written. Starting mitmdump...")

    mitmdump = subprocess.Popen([
        "mitmdump",
        "--mode", "transparent",
        "--listen-host", "0.0.0.0",
        "--listen-port", str(PROXY_PORT),
        "-s", "/usr/local/bin/policy.py",
        "--set", f"policy_file={POLICY_FILE}",
        "-v",
    ])

    def forward_signal(signum: int, _frame: object) -> None:
        mitmdump.send_signal(signum)

    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)

    exit_code = mitmdump.wait()
    log(f"mitmdump exited with code {exit_code}. Cleaning up...")

    setup_iptables.teardown()
    MARKER_FILE.unlink(missing_ok=True)

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
