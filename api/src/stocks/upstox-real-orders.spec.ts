import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import axios from 'axios';
import { UpstoxService } from './upstox.service';

test('real broker orders use intraday market protection, dynamic margin and no retry', async t => {
  const requests: any[] = [];
  t.mock.method(axios, 'request', async (input: any) => {
    requests.push(input);
    if (input.url.endsWith('/margin')) return { data: { status: 'success', data: { required_margin: 75 } } };
    return { data: { status: 'success', data: { order_ids: ['one'] } } };
  });
  const broker = new UpstoxService({ accessToken: async () => 'test-only-token' } as never, {} as never);
  assert.equal(await broker.intradayMargin('u', 'NSE_EQ|TEST', 'SELL', 3), 75);
  assert.deepEqual(requests[0].data.instruments, [{ instrument_key: 'NSE_EQ|TEST', quantity: 3, transaction_type: 'SELL', product: 'I' }]);
  await broker.placeIntradayMarket('u', 'NSE_EQ|TEST', 'SELL', 3, 'test-tag');
  assert.equal(requests[1].url, 'https://api-hft.upstox.com/v3/order/place');
  assert.equal(requests[1].data.product, 'I');
  assert.equal(requests[1].data.market_protection, -1);
  assert.equal(requests[1].data.order_type, 'MARKET');
  assert.equal(requests[1].data.slice, false);
  assert.equal(requests[1].data.tag, 'test-tag');
  let calls = 0;
  t.mock.method(axios, 'request', async () => { calls++; throw new Error('timeout'); });
  await assert.rejects(broker.placeIntradayMarket('u', 'NSE_EQ|TEST', 'BUY', 3, 'unique'), /timeout/);
  assert.equal(calls, 1);
});
