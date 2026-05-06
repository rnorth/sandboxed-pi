# Egress proxy container for sandboxed-pi
#
# This image runs mitmproxy with a policy addon that enforces an allowlist
# on outbound HTTP/HTTPS traffic. All TCP 80/443 from the workload container
# is redirected through this proxy via iptables REDIRECT in a shared network
# namespace.
#
# The entrypoint script sets up iptables rules and then runs mitmdump with
# the policy addon.

FROM ghcr.io/mitmproxy/mitmproxy:10

# Install iptables (minimal images may not have it)
# Also install PyYAML for the policy addon
RUN apt-get update && apt-get install -y --no-install-recommends \
    iptables \
    iproute2 \
    procps \
    ca-certificates \
    python3-pip \
    && pip install --no-cache-dir pyyaml dnslib \
    && rm -rf /var/lib/apt/lists/*

# Create directories for policy and audit log
RUN mkdir -p /etc/sandboxed-pi /var/log/sandboxed-pi /var/run/sandboxed-pi
RUN chmod 755 /etc/sandboxed-pi /var/log/sandboxed-pi /var/run/sandboxed-pi

# Copy the policy addon and iptables setup script
COPY policy.py /usr/local/bin/policy.py
RUN chmod +x /usr/local/bin/policy.py

COPY dns_interceptor.py /usr/local/bin/dns_interceptor.py
COPY setup_iptables.py /usr/local/bin/setup_iptables.py
COPY entrypoint.py /usr/local/bin/entrypoint.py
RUN chmod +x /usr/local/bin/setup_iptables.py /usr/local/bin/entrypoint.py

USER root

ENTRYPOINT ["python3", "/usr/local/bin/entrypoint.py"]
CMD []