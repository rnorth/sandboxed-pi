#!/bin/bash
# Entrypoint for the egress proxy container.
# Sets up iptables rules via setup_iptables.py and runs mitmdump.

set -e

POLICY_FILE="${1:-/etc/sandboxed-pi/policy.yaml}"
PROXY_PORT=8080
MARKER_FILE="/var/run/sandboxed-pi/proxy-ready"
CERT_DIR="/root/.mitmproxy"
CERT_FILE="$CERT_DIR/mitmproxy-ca-cert.pem"

echo "[entrypoint] Starting setup..."
echo "[entrypoint] Policy file: $POLICY_FILE"

# Wait for the network namespace to be ready.
wait_for_network() {
    echo "[entrypoint] Waiting for network..."
    local retries=10
    while [ $retries -gt 0 ]; do
        if ip addr show > /dev/null 2>&1; then
            echo "[entrypoint] Network ready"
            return 0
        fi
        sleep 0.5
        retries=$((retries - 1))
    done
    echo "Warning: Network not ready, proceeding anyway" >&2
}

# Ensure the mitmproxy CA certificate has been generated before we signal
# ready. mitmproxy generates it lazily on first connection; we force that
# by starting a short-lived mitmdump process that makes one HTTP request to
# a known-safe host (dns.google/80) and exits.
generate_ca_cert() {
    echo "[entrypoint] Checking for existing CA cert at $CERT_FILE"
    if [ -f "$CERT_FILE" ]; then
        echo "[entrypoint] CA cert already exists, skipping generation"
        return 0
    fi
    
    echo "[entrypoint] Generating CA cert (up to 10 retries, ~5s each)..."
    local retries=10
    while [ $retries -gt 0 ]; do
        echo "[entrypoint] CA cert attempt $retries remaining..."
        if [ -f "$CERT_FILE" ]; then
            echo "[entrypoint] CA cert generated successfully"
            return 0
        fi
        # Start mitmdump briefly to trigger cert generation.
        # Use --set confdir to specify cert directory.
        # mitmdump --no-server should exit after processing options.
        echo "[entrypoint] Running mitmdump to generate cert..."
        timeout 10 mitmdump --set confdir="$CERT_DIR" --no-server 2>&1 &
        local pid=$!
        # Wait for mitmdump to generate cert files
        sleep 3
        echo "[entrypoint] Stopping mitmdump..."
        kill -0 $pid 2>/dev/null && kill $pid 2>/dev/null || true
        wait $pid 2>/dev/null || true
        retries=$((retries - 1))
    done
    echo "Warning: mitmproxy CA cert not found at $CERT_FILE after retries" >&2
}

# Cleanup function
cleanup() {
    echo "[entrypoint] Cleaning up iptables rules..."
    iptables -t nat -F SANDBOXED_PI 2>/dev/null || true
    iptables -t filter -D OUTPUT -j SANDBOXED_PI 2>/dev/null || true
    iptables -t filter -F SANDBOXED_PI 2>/dev/null || true
    iptables -t filter -X SANDBOXED_PI 2>/dev/null || true
    ip6tables -D OUTPUT -j SANDBOXED_PI 2>/dev/null || true
    ip6tables -F SANDBOXED_PI 2>/dev/null || true
    ip6tables -X SANDBOXED_PI 2>/dev/null || true
    rm -f "$MARKER_FILE"
}

trap cleanup EXIT

echo "[entrypoint] Setting up egress proxy..."
wait_for_network
echo "[entrypoint] Running iptables setup..."
sysctl -w net.ipv4.ip_forward=1 2>/dev/null || true
python3 /usr/local/bin/setup_iptables.py "$PROXY_PORT"

echo "[entrypoint] Running CA cert generation..."
generate_ca_cert

# Signal that setup is complete (including cert generation).
echo "[entrypoint] Writing ready marker..."
echo "ready" > "$MARKER_FILE"
echo "[entrypoint] ready marker written"
echo "iptables rules installed, CA cert ready, mitmdump starting on port $PROXY_PORT"

# Run mitmdump with the policy addon.
echo "[entrypoint] Starting mitmdump..."
exec mitmdump \
    --mode transparent \
    --listen-host 0.0.0.0 \
    --listen-port $PROXY_PORT \
    -s /usr/local/bin/policy.py \
    --set policy_file="$POLICY_FILE" \
    -v
