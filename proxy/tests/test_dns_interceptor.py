import threading

import dnslib
from dns_interceptor import BindingCache, DnsInterceptor


class TestBindingCache:
    def test_record_and_is_bound(self):
        cache = BindingCache()
        cache.record("api.github.com", "140.82.121.6")
        assert cache.is_bound("api.github.com", "140.82.121.6")

    def test_unrecorded_ip_not_bound(self):
        cache = BindingCache()
        assert not cache.is_bound("api.github.com", "1.2.3.4")

    def test_wrong_host_not_bound(self):
        cache = BindingCache()
        cache.record("api.github.com", "140.82.121.6")
        assert not cache.is_bound("evil.com", "140.82.121.6")

    def test_multiple_ips_all_bound(self):
        cache = BindingCache()
        cache.record("api.github.com", "140.82.121.6")
        cache.record("api.github.com", "140.82.121.7")
        assert cache.is_bound("api.github.com", "140.82.121.6")
        assert cache.is_bound("api.github.com", "140.82.121.7")

    def test_thread_safety(self):
        cache = BindingCache()
        errors = []

        def worker(i):
            try:
                cache.record("host.example.com", f"10.0.0.{i}")
                cache.is_bound("host.example.com", f"10.0.0.{i}")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert not errors


class TestDnsInterceptorRouting:
    """Tests for query routing decisions. Uses a fake upstream to avoid real DNS calls."""

    ALLOWED_HOSTS = frozenset({"api.github.com", "registry.npmjs.org"})

    def _make_interceptor(self, upstream_response=None):
        cache = BindingCache()
        fake_upstream = FakeUpstream(upstream_response)
        interceptor = DnsInterceptor(
            allowed_hosts=self.ALLOWED_HOSTS,
            cache=cache,
            audit_log_path="/dev/null",
            audit_lock=__import__("threading").Lock(),
            upstream=fake_upstream,
        )
        return interceptor, fake_upstream, cache

    def test_aaaa_query_returns_nodata(self):
        interceptor, _, _ = self._make_interceptor()
        request = dnslib.DNSRecord.question("api.github.com", "AAAA")
        response = interceptor._handle(request)
        assert response.header.rcode == dnslib.RCODE.NOERROR
        assert len(response.rr) == 0

    def test_ptr_query_returns_nxdomain(self):
        interceptor, _, _ = self._make_interceptor()
        request = dnslib.DNSRecord.question("6.121.82.140.in-addr.arpa", "PTR")
        response = interceptor._handle(request)
        assert response.header.rcode == dnslib.RCODE.NXDOMAIN

    def test_non_policy_host_returns_nxdomain(self):
        interceptor, _, _ = self._make_interceptor()
        request = dnslib.DNSRecord.question("evil.com", "A")
        response = interceptor._handle(request)
        assert response.header.rcode == dnslib.RCODE.NXDOMAIN

    def test_allowed_host_a_query_forwarded(self):
        upstream_reply = _make_a_response("api.github.com", "140.82.121.6")
        interceptor, fake_upstream, _ = self._make_interceptor(upstream_reply)
        request = dnslib.DNSRecord.question("api.github.com", "A")
        response = interceptor._handle(request)
        assert fake_upstream.called
        assert response.header.rcode == dnslib.RCODE.NOERROR

    def test_allowed_host_txt_query_forwarded(self):
        upstream_reply = _make_nodata_response("api.github.com")
        interceptor, fake_upstream, _ = self._make_interceptor(upstream_reply)
        request = dnslib.DNSRecord.question("api.github.com", "TXT")
        response = interceptor._handle(request)
        assert fake_upstream.called

    def test_upstream_error_returns_servfail(self):
        cache = BindingCache()
        broken = DnsInterceptor(
            allowed_hosts=self.ALLOWED_HOSTS,
            cache=cache,
            audit_log_path="/dev/null",
            audit_lock=__import__("threading").Lock(),
            upstream=BrokenUpstream(),
        )
        request = dnslib.DNSRecord.question("api.github.com", "A")
        response = broken._handle(request)
        assert response.header.rcode == dnslib.RCODE.SERVFAIL


class FakeUpstream:
    def __init__(self, response):
        self._response = response
        self.called = False

    def __call__(self, request):
        self.called = True
        if self._response is None:
            raise OSError("no response configured")
        return self._response


class BrokenUpstream:
    def __call__(self, request):
        raise OSError("simulated upstream failure")


def _make_a_response(name: str, ip: str) -> dnslib.DNSRecord:
    reply = dnslib.DNSRecord(dnslib.DNSHeader(qr=1, aa=1, ra=1))
    reply.add_question(dnslib.DNSQuestion(name))
    reply.add_answer(dnslib.RR(name, dnslib.QTYPE.A, rdata=dnslib.A(ip), ttl=300))
    return reply


def _make_nodata_response(name: str) -> dnslib.DNSRecord:
    reply = dnslib.DNSRecord(dnslib.DNSHeader(qr=1, aa=1, ra=1))
    reply.add_question(dnslib.DNSQuestion(name))
    return reply
