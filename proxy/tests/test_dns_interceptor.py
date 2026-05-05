import threading
from dns_interceptor import BindingCache


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
