"""Internal broker transport. Trading decisions remain in the existing engine."""
import asyncio
import hmac
import logging
import os
import time
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web

LOG = logging.getLogger("python-market")
KEY = web.AppKey("key", str)
DATA = web.AppKey("data", aiohttp.ClientSession)
ORDERS = web.AppKey("orders", aiohttp.ClientSession)
STREAMS = web.AppKey("streams", aiohttp.ClientSession)
SOCKETS = web.AppKey("sockets", set)
STATS = web.AppKey("stats", dict)


def valid_target(url, stream=False):
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    valid_host = (host == "upstox.com" or host.endswith(".upstox.com")) if stream else host in {"api.upstox.com", "api-hft.upstox.com"}
    return (valid_host and parsed.scheme == ("wss" if stream else "https")
            and not parsed.username and not parsed.password and parsed.port in (None, 443)
            and (stream or parsed.path.startswith(("/v2/", "/v3/"))))


@web.middleware
async def authenticate(request, handler):
    if not hmac.compare_digest(request.headers.get("X-Python-Market-Key", ""), request.app[KEY]):
        raise web.HTTPUnauthorized(text="Internal authentication required")
    return await handler(request)


async def broker_request(request):
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("Invalid broker request")
        url = payload["url"]
        method = payload["method"]
        timeout_ms = payload["timeoutMs"]
        headers = payload["headers"]
        if (not isinstance(method, str) or method not in {"GET", "POST", "DELETE"}
                or not isinstance(url, str) or not valid_target(url)
                or not isinstance(timeout_ms, (int, float)) or not 0 < timeout_ms <= 30000
                or not isinstance(headers, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items())
                or not headers.get("Authorization", "").startswith("Bearer ")
                or not isinstance(payload.get("params", {}), dict)):
            raise ValueError("Invalid broker request")
    except (KeyError, TypeError, ValueError):
        raise web.HTTPBadRequest(text="Invalid broker request")
    # Only broker-specific headers cross this boundary; internal keys never do.
    headers = {k: v for k, v in headers.items() if k in {"Authorization", "Accept", "Content-Type", "X-Algo-Name"}}
    execution_read = urlsplit(url).path.startswith(("/v2/order/", "/v2/portfolio/", "/v2/user/", "/v2/feed/portfolio-stream-feed/"))
    session = request.app[ORDERS if method != "GET" or execution_read else DATA]
    started = time.monotonic()
    request.app[STATS]["requests"] += 1
    try:
        # Exactly one network attempt. Never retry or fall back after submission.
        async with session.request(method, url, params=payload.get("params"),
                                   json=payload.get("data"), headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=timeout_ms / 1000, ceil_threshold=60),
                                   allow_redirects=False) as response:
            body = await response.read()
            elapsed = round((time.monotonic() - started) * 1000, 2)
            request.app[STATS]["lastRequestMs"] = elapsed
            returned_headers = {"Content-Type": response.headers.get("Content-Type", "application/json"),
                                "X-Python-Broker-Ms": str(elapsed)}
            if "Retry-After" in response.headers:
                returned_headers["Retry-After"] = response.headers["Retry-After"]
            return web.Response(body=body, status=response.status, headers=returned_headers)
    except (aiohttp.ClientError, asyncio.TimeoutError):
        request.app[STATS]["transportErrors"] += 1
        # Do not report a broker rejection: an order may have reached the broker.
        return web.json_response({"message": "Broker transport outcome unavailable; reconcile before resubmitting"}, status=502)


async def relay_stream(request):
    url = request.headers.get("X-Broker-Stream-Url", "")
    token = request.headers.get("X-Broker-Authorization", "")
    try:
        if not valid_target(url, stream=True) or not token.startswith("Bearer "):
            raise ValueError("Invalid stream")
    except ValueError:
        raise web.HTTPBadRequest(text="Invalid broker stream")
    # Upstream must be ready before the downstream 'open' subscription is sent.
    try:
        upstream = await request.app[STREAMS].ws_connect(
            url, headers={"Authorization": token, "Accept": "*/*"},
            heartbeat=20, max_msg_size=8 * 1024 * 1024)
    except (aiohttp.ClientError, asyncio.TimeoutError):
        raise web.HTTPBadGateway(text="Broker stream unavailable")
    downstream = web.WebSocketResponse(heartbeat=20, max_msg_size=8 * 1024 * 1024)
    tasks = []
    try:
        await downstream.prepare(request)
        request.app[SOCKETS].add(downstream)

        async def forward(source, destination, is_broker):
            async for message in source:
                if message.type == aiohttp.WSMsgType.BINARY:
                    # Binary protobuf/subscription frames are preserved byte for byte.
                    await destination.send_bytes(message.data)
                elif message.type == aiohttp.WSMsgType.TEXT:
                    await destination.send_str(message.data)
                else:
                    break
                if is_broker:
                    request.app[STATS]["frames"] += 1
                    request.app[STATS]["lastFrameReceivedAt"] = int(time.time() * 1000)

        tasks = [asyncio.create_task(forward(upstream, downstream, True)),
                 asyncio.create_task(forward(downstream, upstream, False))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await upstream.close()
        await downstream.close()
        request.app[SOCKETS].discard(downstream)
    return downstream


async def resources(app):
    # Separate pools prevent scanners from consuming execution connections.
    for key, limit in ((DATA, 40), (ORDERS, 20), (STREAMS, 20)):
        app[key] = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(limit=limit, ttl_dns_cache=300, keepalive_timeout=60),
            cookie_jar=aiohttp.DummyCookieJar(), trust_env=False,
            timeout=aiohttp.ClientTimeout(total=15, ceil_threshold=60))
    yield
    for key in (DATA, ORDERS, STREAMS):
        await app[key].close()


async def shutdown(app):
    await asyncio.gather(*(socket.close(code=1001) for socket in list(app[SOCKETS])), return_exceptions=True)


async def health(request):
    return web.json_response({"status": "ok", "transport": "python", "activeStreams": len(request.app[SOCKETS]), **request.app[STATS]})


def create_app(key):
    if len(key) < 32:
        raise ValueError("PYTHON_MARKET_KEY must contain at least 32 characters")
    app = web.Application(middlewares=[authenticate], client_max_size=1024 * 1024)
    app[KEY] = key
    app[SOCKETS] = set()
    app[STATS] = {"requests": 0, "transportErrors": 0, "frames": 0, "lastFrameReceivedAt": None, "lastRequestMs": None}
    app.cleanup_ctx.append(resources)
    app.on_shutdown.append(shutdown)
    app.router.add_get("/health", health)
    app.router.add_post("/broker", broker_request)
    app.router.add_get("/stream", relay_stream)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    web.run_app(create_app(os.environ.get("PYTHON_MARKET_KEY", "")),
                host="127.0.0.1", port=int(os.environ.get("PYTHON_MARKET_PORT", "4100")),
                access_log=None)
