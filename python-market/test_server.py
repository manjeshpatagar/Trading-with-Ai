import asyncio
import unittest
from unittest.mock import patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server import create_app, valid_target, DATA, ORDERS

SECRET = "test-secret-" * 4


class BrokerIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.block = asyncio.Event()

        async def broker(request):
            self.calls.append((request.method, request.path, await request.read(), dict(request.headers)))
            if request.path == "/slow":
                await self.block.wait()
            if request.path == "/limited":
                return web.json_response({"status": "error", "errors": [{"message": "quota"}]}, status=429, headers={"Retry-After": "2"})
            return web.json_response({"status": "success", "data": {"order_ids": ["test-order"]}})

        async def stream(request):
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            async for message in socket:
                if message.type == aiohttp.WSMsgType.BINARY:
                    # A target touch followed by a pullback must both arrive.
                    await socket.send_bytes(message.data)
                    await socket.send_bytes(b"target-touch")
                    await socket.send_bytes(b"pullback")
                    break
            await socket.close()
            return socket

        upstream = web.Application()
        upstream.router.add_get("/stream", stream)
        upstream.router.add_route("*", "/{path}", broker)
        self.upstream = TestServer(upstream)
        await self.upstream.start_server()
        self.client = TestClient(TestServer(create_app(SECRET)))
        await self.client.start_server()

    async def asyncTearDown(self):
        self.block.set()
        await self.client.close()
        await self.upstream.close()

    def payload(self, path="/order", method="POST", timeout=1000):
        return {"method": method, "url": str(self.upstream.make_url(path)), "timeoutMs": timeout,
                "data": {"tag": "unique", "quantity": 3}, "headers": {"Authorization": "Bearer fixture", "X-Python-Market-Key": "must-not-forward"}}

    async def send(self, payload):
        return await self.client.post("/broker", json=payload, headers={"X-Python-Market-Key": SECRET})

    async def test_authentication_and_url_boundary(self):
        response = await self.client.get("/health")
        self.assertEqual(response.status, 401)
        response = await self.send(self.payload())
        self.assertEqual(response.status, 400)
        self.assertEqual(self.calls, [])
        for url in ["https://api.upstox.com.evil.test/v2/order", "http://api.upstox.com/v2/order", "https://secret@api.upstox.com/v2/order", "https://api.upstox.com:123/v2/order", "https://127.0.0.1/v2/order"]:
            self.assertFalse(valid_target(url))
        self.assertTrue(valid_target("https://api-hft.upstox.com/v3/order/place"))
        self.assertTrue(valid_target("wss://wsfeeder-api.upstox.com/feed", True))
        self.assertFalse(valid_target("wss://upstox.com.evil.test/feed", True))

    async def test_exact_order_payload_and_no_credentials_forwarded(self):
        with patch("server.valid_target", return_value=True):
            response = await self.send(self.payload())
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())["data"]["order_ids"], ["test-order"])
        self.assertEqual(len(self.calls), 1)
        self.assertIn(b'"tag": "unique"', self.calls[0][2])
        self.assertEqual(self.calls[0][3]["Authorization"], "Bearer fixture")
        self.assertNotIn("X-Python-Market-Key", self.calls[0][3])
        self.assertIn("X-Python-Broker-Ms", response.headers)

    async def test_rate_limit_status_and_retry_after_preserved(self):
        with patch("server.valid_target", return_value=True):
            response = await self.send(self.payload("/limited", "GET"))
            self.assertEqual(response.status, 429)
            self.assertEqual(response.headers["Retry-After"], "2")
            self.assertEqual((await response.json())["errors"][0]["message"], "quota")
        self.assertEqual(len(self.calls), 1, "Python must not add retries")

    async def test_submission_timeout_is_unknown_without_retry(self):
        with patch("server.valid_target", return_value=True):
            response = await self.send(self.payload("/slow", timeout=50))
            self.assertEqual(response.status, 502)
            self.assertNotEqual((await response.json()).get("status"), "error")
        self.assertEqual(len(self.calls), 1)

    async def test_slow_data_request_does_not_block_order(self):
        self.assertIsNot(self.client.server.app[DATA].connector, self.client.server.app[ORDERS].connector)
        with patch("server.valid_target", return_value=True):
            slow = asyncio.create_task(self.send(self.payload("/slow", "GET")))
            while not self.calls:
                await asyncio.sleep(0.001)
            response = await asyncio.wait_for(self.send(self.payload()), timeout=0.5)
            self.assertEqual(response.status, 200)
            self.assertFalse(slow.done())
            self.block.set()
            await slow

    async def test_stream_preserves_binary_subscription_and_target_pullback_order(self):
        with patch("server.valid_target", return_value=True):
            socket = await self.client.ws_connect("/stream", headers={
                "X-Python-Market-Key": SECRET,
                "X-Broker-Stream-Url": str(self.upstream.make_url("/stream")),
                "X-Broker-Authorization": "Bearer fixture"})
            await socket.send_bytes(b"subscription-protobuf")
            received = [(await socket.receive(timeout=1)).data for _ in range(3)]
            self.assertEqual(received, [b"subscription-protobuf", b"target-touch", b"pullback"])
            await socket.close()
        response = await self.client.get("/health", headers={"X-Python-Market-Key": SECRET})
        self.assertEqual((await response.json())["frames"], 3)


if __name__ == "__main__":
    unittest.main()
