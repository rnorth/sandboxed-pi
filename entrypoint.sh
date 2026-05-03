#!/bin/bash
# Entrypoint for the egress proxy container.
# Sets up iptables REDIRECT for TCP 80/443 traffic and runs mitmdump.

set -e

POLICY_FILE="${1:-/etc/sandboxed-pi/policy.yaml}"
PROXY_PORT=8080
MARKER_FILE="/var/run/sandboxed-pi/proxy-ready"

# Function to set up iptables rules
setup_iptables() {
    # Get the UID of the proxy process (mitmdump) so we can exempt its traffic
    # We use --uid-owner to exempt traffic FROM the proxy itself
    local proxy_uid=$(id -u root)

    # Enable IP forwarding
    sysctl -w net.ipv4.ip_forward=1 2>/dev/null || true

    # Flush any existing rules in the nat table (optional, idempotent)
    # Note: We only touch our own chains to avoid disrupting host rules
    iptables -t nat -F 2>/dev/null || true

    # REDIRECT TCP 80/443 to the proxy port, exempting the proxy's own traffic
    # --uid-owner exempts traffic from the proxy itself so it can reach upstreams
    iptables -t nat -A OUTPUT \
        -p tcp \
        --dport 80 \
        -m owner ! --uid-owner root \
        -j REDIRECT --to-port $PROXY_PORT

    iptables -t nat -A OUTPUT \
        -p tcp \
        --dport 443 \
        -m owner ! --uid-owner root \
        -j REDIRECT --to-port $PROXY_PORT

    # For non-local destinations (load balancer scenarios)
    # Also handle traffic via the nat table's PREROUTING chain
    iptables -t nat -A PREROUTING \
        -p tcp \
        --dport 80 \
        -j REDIRECT --to-port $PROXY_PORT

    iptables -t nat -A PREROUTING \
        -p tcp \
        --dport 443 \
        -j REDIRECT --to-port $PROXY_PORT
}

# Wait for the network namespace to be ready
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

# Cleanup function
cleanup() {
    echo "Cleaning up iptables rules..."
    iptables -t nat -F 2>/dev/null || true
    rm -f "$MARKER_FILE"
}

# Register cleanup on exit
trap cleanup EXIT

# Main setup
echo "Setting up egress proxy..."
wait_for_network
setup_iptables

# Signal that we're ready
echo "ready" > "$MARKER_FILE"
echo "iptables rules installed, mitmdump starting on port $PROXY_PORT"

# Run mitmdump with the policy addon
# -v: verbose output
# -s: load script
# --listen-host 0.0.0.0: bind to all interfaces in the shared netns
exec mitmdump \
    --listen-host 0.0.0.0 \
    --listen-port $PROXY_PORT \
    -s "policy.py $POLICY_FILE" \
    -v