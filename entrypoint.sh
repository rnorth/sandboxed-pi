#!/bin/bash
# Entrypoint for the egress proxy container.
# Sets up iptables REDIRECT for TCP 80/443 traffic and runs mitmdump.

set -e

POLICY_FILE="${1:-/etc/sandboxed-pi/policy.yaml}"
PROXY_PORT=8080
MARKER_FILE="/var/run/sandboxed-pi/proxy-ready"
CERT_DIR="/root/.mitmproxy"
CERT_FILE="$CERT_DIR/mitmproxy-ca-cert.pem"

# Set up a dedicated iptables chain for our redirects so we can flush
# only our own rules without touching anything else in the NAT table.
setup_iptables() {
    # Enable IP forwarding
    sysctl -w net.ipv4.ip_forward=1 2>/dev/null || true

    # Create a dedicated chain and wire it into OUTPUT.
    # Flipping -F with no chain name only flushes the named chain, not the
    # whole table — this lets us clean up on restart without disrupting
    # other rules that might exist in the shared netns.
    iptables -t nat -N SANDBOXED_PI 2>/dev/null || iptables -t nat -F SANDBOXED_PI
    iptables -t nat -A OUTPUT -j SANDBOXED_PI
    iptables -t nat -A PREROUTING -j SANDBOXED_PI

    # Redirect TCP 80/443 for all non-root UIDs (exempt mitmdump's own traffic
    # so it can reach upstreams through the transparent redirect).
    iptables -t nat -A SANDBOXED_PI \
        -p tcp --dport 80 \
        -m owner ! --uid-owner root \
        -j REDIRECT --to-port $PROXY_PORT

    iptables -t nat -A SANDBOXED_PI \
        -p tcp --dport 443 \
        -m owner ! --uid-owner root \
        -j REDIRECT --to-port $PROXY_PORT
}

# Wait for the network namespace to be ready.
wait_for_network() {
    local retries=10
    while [ $retries -gt 0 ]; do
        if ip addr show > /dev/null 2>&1; then
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
    local retries=20
    while [ $retries -gt 0 ]; do
        if [ -f "$CERT_FILE" ]; then
            return 0
        fi
        # Start mitmdump briefly to trigger cert generation.
        # --no-server: exit after processing setup (no full proxy loop).
        timeout 5 mitmdump --set confdir="$CERT_DIR" --no-server 2>/dev/null &
        local pid=$!
        sleep 2
        kill -0 $pid 2>/dev/null && kill $pid 2>/dev/null
        wait $pid 2>/dev/null
        retries=$((retries - 1))
    done
    echo "Warning: mitmproxy CA cert not found at $CERT_FILE after retries" >&2
}

# Cleanup function
cleanup() {
    echo "Cleaning up iptables rules..."
    iptables -t nat -F SANDBOXED_PI 2>/dev/null || true
    rm -f "$MARKER_FILE"
}

trap cleanup EXIT

echo "Setting up egress proxy..."
wait_for_network
setup_iptables

# Generate the CA cert before signalling ready so callers can copy it immediately.
generate_ca_cert

# Signal that setup is complete (including cert generation).
echo "ready" > "$MARKER_FILE"
echo "iptables rules installed, CA cert ready, mitmdump starting on port $PROXY_PORT"

# Run mitmdump with the policy addon.
exec mitmdump \
    --listen-host 0.0.0.0 \
    --listen-port $PROXY_PORT \
    -s "policy.py $POLICY_FILE" \
    -v
