import threading
from collections import defaultdict


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
