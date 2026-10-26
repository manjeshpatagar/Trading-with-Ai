import { test, TestContext } from 'node:test';
import { strict as assert } from 'node:assert';
import axios, { AxiosError } from 'axios';
import { pythonBrokerStream, pythonTransportConfig } from './python-broker-transport';
import { UpstoxService } from './upstox.service';

function enablePython(t: TestContext) {
  const previousUrl = process.env.PYTHON_MARKET_URL;
  const previousKey = process.env.PYTHON_MARKET_KEY;
  process.env.PYTHON_MARKET_URL = 'http://127.0.0.1:4100';
  process.env.PYTHON_MARKET_KEY = 'fixture-secret-'.repeat(3);
  t.after(() => {
    if (previousUrl === undefined) delete process.env.PYTHON_MARKET_URL; else process.env.PYTHON_MARKET_URL = previousUrl;
    if (previousKey === undefined) delete process.env.PYTHON_MARKET_KEY; else process.env.PYTHON_MARKET_KEY = previousKey;
  });
}

test('Python routing preserves broker payload, order tag and single submission on uncertain response', async t => {
  enablePython(t);
  const calls: any[] = [];
  t.mock.method(axios, 'post', async (url: string, payload: any, config: any) => {
    calls.push({ url, payload, config });
    if (calls.length > 1) throw new AxiosError('Transport outcome unavailable', 'ERR_BAD_RESPONSE', undefined, undefined,
      { status: 502, data: { message: 'unknown' }, headers: {}, config: {} as never, statusText: 'Bad Gateway' });
    return { data: { status: 'success', data: { order_ids: ['one'] } } };
  });
  const broker = new UpstoxService({ accessToken: async () => 'fixture-token' } as never, {} as never);
  await broker.placeIntradayMarket('u', 'NSE_EQ|TEST', 'BUY', 3, 'unique-order-tag');
  assert.equal(calls[0].url, 'http://127.0.0.1:4100/broker');
  assert.equal(calls[0].payload.url, 'https://api-hft.upstox.com/v3/order/place');
  assert.equal(calls[0].payload.data.tag, 'unique-order-tag');
  assert.equal(calls[0].payload.data.product, 'I');
  assert.equal(calls[0].payload.data.market_protection, -1);
  assert.equal(calls[0].payload.timeoutMs, 3000);
  assert.equal(calls[0].config.maxRedirects, 0);
  await assert.rejects(broker.placeIntradayMarket('u', 'NSE_EQ|TEST', 'BUY', 3, 'second-tag'));
  assert.equal(calls.length, 2, 'one attempt each; no fallback submission');
});

test('LTP fetching uses Python without changing the broker query', async t => {
  enablePython(t);
  let payload: any;
  t.mock.method(axios, 'post', async (_url: string, body: any) => { payload = body; return { data: { data: { price: 183.4 } } }; });
  const broker = new UpstoxService({ accessToken: async () => 'fixture-token' } as never, {} as never);
  assert.deepEqual(await broker.ltp('u', 'NSE_EQ|TEST', 10000), { data: { price: 183.4 } });
  assert.equal(payload.method, 'GET');
  assert.deepEqual(payload.params, { instrument_key: 'NSE_EQ|TEST' });
});

test('stream credentials use internal headers and invalid transport origins fail closed', t => {
  enablePython(t);
  const upstream = 'wss://wsfeeder-api.upstox.com/feed?token=fixture';
  const stream = pythonBrokerStream(upstream, 'fixture-token');
  assert.equal(stream.url, 'ws://127.0.0.1:4100/stream');
  assert.equal(stream.headers['X-Broker-Stream-Url'], upstream);
  process.env.PYTHON_MARKET_URL = 'http://external.example:4100';
  assert.throws(() => pythonTransportConfig(), /loopback/);
  delete process.env.PYTHON_MARKET_URL;
  assert.equal(pythonBrokerStream(upstream, 'fixture-token').url, upstream);
});
