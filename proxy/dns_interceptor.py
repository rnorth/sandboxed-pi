import json
import socket
import threading
from collections import defaultdict
from typing import Callable, Optional

import dnslib

DNS_LISTEN_PORT = 5353
_DNS_TIMEOUT = 5.0


class BindingCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._host_to_ips: dict[str, set[str]] = defaultdict(set)

    def record(self, host: str, ip: str) -> None:
        with self._lock:
            self._host_to_ips[host].add(ip)

    def is_bound(self, host: str, ip: str) -> bool:
        with self._lock:
            return ip in self._host_to_ips.get(host, set())


class DnsInterceptor:
    def __init__(
        self,
        allowed_hosts: frozenset,
        cache: BindingCache,
        audit_log_path: str,
        audit_lock: threading.Lock,
        upstream: Optional[Callable] = None,
        listen_port: int = DNS_LISTEN_PORT,
    ):
        self._allowed_hosts = allowed_hosts
        self._cache = cache
        self._audit_log_path = audit_log_path
        self._audit_lock = audit_lock
        self._upstream = upstream or self._real_upstream
        self._listen_port = listen_port
        self._thread: Optional[threading.Thread] = None
        self._sock: Optional[socket.socket] = None

    def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.bind(("127.0.0.1", self._listen_port))
        self._sock.settimeout(_DNS_TIMEOUT)
        self._thread = threading.Thread(target=self._serve, daemon=True, name="dns-interceptor")
        self._thread.start()

    def is_alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def join(self) -> None:
        if self._thread is not None:
            self._thread.join()

    def _serve(self) -> None:
        while True:
            try:
                data, addr = self._sock.recvfrom(512)
                request = dnslib.DNSRecord.parse(data)
                response = self._handle(request)
                self._sock.sendto(response.pack(), addr)
            except socket.timeout:
                continue
            except Exception:
                break

    def _handle(self, request: dnslib.DNSRecord) -> dnslib.DNSRecord:
        q = request.q
        qname = str(q.qname).rstrip(".")
        qtype = q.qtype

        if qtype == dnslib.QTYPE.AAAA:
            self._audit("DNS-DENY", qname, "AAAA")
            return self._nodata(request)

        if qtype == dnslib.QTYPE.PTR:
            self._audit("DNS-DENY", qname, "PTR")
            return self._nxdomain(request)

        if qname not in self._allowed_hosts:
            self._audit("DNS-DENY", qname, dnslib.QTYPE.get(qtype, str(qtype)))
            return self._nxdomain(request)

        try:
            response = self._upstream(request)
            # Cache A record IPs before returning response to workload (race-free)
            if qtype == dnslib.QTYPE.A:
                for rr in response.rr:
                    if rr.rtype == dnslib.QTYPE.A:
                        self._cache.record(qname, str(rr.rdata))
            self._audit("DNS-ALLOW", qname, dnslib.QTYPE.get(qtype, str(qtype)))
            return response
        except Exception:
            self._audit("DNS-DENY", qname, dnslib.QTYPE.get(qtype, str(qtype)))
            return self._servfail(request)

    def _real_upstream(self, request: dnslib.DNSRecord) -> dnslib.DNSRecord:
        upstream_addr = self._get_upstream_resolver()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(_DNS_TIMEOUT)
        try:
            sock.sendto(request.pack(), (upstream_addr, 53))
            data, _ = sock.recvfrom(512)
            return dnslib.DNSRecord.parse(data)
        finally:
            sock.close()

    def _get_upstream_resolver(self) -> str:
        with open("/etc/resolv.conf") as f:
            for line in f:
                if line.startswith("nameserver"):
                    return line.split()[1]
        return "8.8.8.8"

    def _nxdomain(self, request: dnslib.DNSRecord) -> dnslib.DNSRecord:
        reply = request.reply()
        reply.header.rcode = dnslib.RCODE.NXDOMAIN
        return reply

    def _nodata(self, request: dnslib.DNSRecord) -> dnslib.DNSRecord:
        reply = request.reply()
        reply.header.rcode = dnslib.RCODE.NOERROR
        return reply

    def _servfail(self, request: dnslib.DNSRecord) -> dnslib.DNSRecord:
        reply = request.reply()
        reply.header.rcode = dnslib.RCODE.SERVFAIL
        return reply

    def _audit(self, decision: str, name: str, qtype: str) -> None:
        entry = json.dumps({"event": "dns", "decision": decision, "name": name, "qtype": str(qtype)})
        with self._audit_lock:
            try:
                with open(self._audit_log_path, "a") as f:
                    f.write(entry + "\n")
            except OSError as e:
                import sys
                print(f"[sandboxed-pi] audit write failed: {e}", file=sys.stderr)
