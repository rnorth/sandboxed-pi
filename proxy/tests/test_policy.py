import threading
from unittest.mock import MagicMock
from dns_interceptor import BindingCache
from policy import _is_ip_address, _check_binding


class TestIsIpAddress:
    def test_ipv4_recognised(self):
        assert _is_ip_address("140.82.121.6")

    def test_hostname_not_ip(self):
        assert not _is_ip_address("api.github.com")

    def test_empty_string_not_ip(self):
        assert not _is_ip_address("")


class TestCheckBinding:
    def _cache_with(self, host, ip):
        cache = BindingCache()
        cache.record(host, ip)
        return cache

    def test_known_ip_allowed(self):
        cache = self._cache_with("api.github.com", "140.82.121.6")
        assert _check_binding("api.github.com", "140.82.121.6", cache)

    def test_unknown_ip_denied(self):
        cache = BindingCache()
        assert not _check_binding("api.github.com", "140.82.121.6", cache)

    def test_wrong_host_denied(self):
        cache = self._cache_with("api.github.com", "140.82.121.6")
        assert not _check_binding("evil.com", "140.82.121.6", cache)

    def test_hostname_dest_allowed(self):
        # If dest_ip is a hostname (not an IP literal), skip binding check
        cache = BindingCache()  # empty — if check ran it would deny
        assert _check_binding("api.github.com", "api.github.com", cache)

    def test_none_dest_allowed(self):
        # If dest_ip is None, skip binding check
        cache = BindingCache()  # empty
        assert _check_binding("api.github.com", None, cache)
