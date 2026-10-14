import asyncio
import json
import tempfile
import unittest
from pathlib import Path

import httpx

from watcher import HealthWatcher, Settings, StateStore, parse_health_response


SAMPLE = Path(__file__).resolve().parents[1] / "模型健康-response.json"


class WatcherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = json.loads(SAMPLE.read_text(encoding="utf-8"))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / "state.sqlite3"
        self.store = StateStore(self.db_path)

    def test_real_response_and_restart_are_quiet(self):
        endpoints = parse_health_response(self.payload)
        self.assertEqual(len(endpoints), 86)
        self.assertEqual(sum(not item.healthy for item in endpoints.values()), 7)
        self.assertEqual(self.store.record_success(endpoints), [])
        restarted = StateStore(self.db_path)
        self.assertEqual(restarted.record_success(endpoints), [])
        self.assertIsNone(restarted.next_message())
        self.assertEqual(restarted.summary()["unhealthy_count"], 7)

    def test_changes_are_grouped_once(self):
        baseline = parse_health_response(self.payload)
        self.store.record_success(baseline)
        changed = json.loads(json.dumps(self.payload))
        became_unhealthy = changed["healthy_endpoints"].pop(0)
        became_unhealthy["error"] = "litellm.ServiceUnavailableError: stack trace and secrets"
        became_unhealthy["exception_status"] = 503
        changed["unhealthy_endpoints"].append(became_unhealthy)
        recovered = changed["unhealthy_endpoints"].pop(0)
        recovered.pop("error", None)
        recovered.pop("exception_status", None)
        changed["healthy_endpoints"].append(recovered)
        changed["unhealthy_endpoints"][0]["exception_status"] = 502
        changed["healthy_count"] = len(changed["healthy_endpoints"])
        changed["unhealthy_count"] = len(changed["unhealthy_endpoints"])
        current = parse_health_response(changed)
        lines = self.store.record_success(current)
        self.assertTrue(any("新增异常" in line for line in lines))
        self.assertTrue(any("已恢复" in line for line in lines))
        self.assertTrue(any("异常类型变化" in line for line in lines))
        self.assertEqual(self.store.record_success(current), [])
        queued = self.store.next_message()
        self.assertIsNotNone(queued)
        self.assertNotIn("stack trace", queued[1])
        self.assertNotIn("raw_request_headers", queued[1])

    def test_source_failure_keeps_snapshot_and_only_notifies_once(self):
        self.store.record_success(parse_health_response(self.payload))
        self.store.record_failure("请求超时")
        self.store.record_failure("请求超时")
        first = self.store.next_message()
        self.assertIsNotNone(first)
        self.store.mark_sent(first[0])
        self.assertIsNone(self.store.next_message())
        self.assertEqual(self.store.summary()["unhealthy_count"], 7)
        lines = self.store.record_success(parse_health_response(self.payload))
        self.assertTrue(any("接口已恢复" in line for line in lines))
        self.assertFalse(self.store.summary()["source_failed"])

    def test_invalid_result_does_not_replace_snapshot(self):
        self.store.record_success(parse_health_response(self.payload))
        invalid = dict(self.payload)
        invalid["healthy_count"] = 1
        with self.assertRaises(ValueError):
            parse_health_response(invalid)
        self.assertEqual(self.store.summary()["healthy_count"], 79)

    def test_webhook_errcode_keeps_outbox_for_retry(self):
        self.store.record_failure("请求超时")
        settings = Settings("http://litellm", "dummy", "http://wecom", self.db_path, 900, 10, 10)
        watcher = HealthWatcher(settings, self.store)
        replies = iter([{"errcode": 40013}, {"errcode": 0}])

        def handle(request):
            self.assertEqual(request.method, "POST")
            self.assertEqual(json.loads(request.content)["msgtype"], "text")
            return httpx.Response(200, json=next(replies))

        async def run():
            await watcher.client.aclose()
            watcher.client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
            await watcher.send_pending()
            self.assertEqual(self.store.summary()["pending_notifications"], 1)
            await watcher.send_pending()
            self.assertEqual(self.store.summary()["pending_notifications"], 0)
            await watcher.client.aclose()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
