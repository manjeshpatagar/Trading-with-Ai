import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import axios, { AxiosError } from 'axios';
import { HttpException } from '@nestjs/common';
import { UpstoxRequestGate, UpstoxRateLimitError, retryAfterMs } from './upstox-rate-limit';
import { UpstoxService } from './upstox.service';

const path = '/v3/market-quote/ltp';
test('parses Retry-After seconds and HTTP dates without confusing absent or invalid headers', () => {
  assert.equal(retryAfterMs('2'), 2_000);
  assert.equal(retryAfterMs('Thu, 17 Sep 2026 17:15:47 GMT', Date.parse('2026-09-17T17:15:45Z')), 2_000);
  assert.equal(retryAfterMs(undefined), null);
  assert.equal(retryAfterMs('-1'), null);
  assert.equal(retryAfterMs('invalid'), null);
});

test('shares cooldown across LTP callers and isolates different users and APIs', async () => {
  let now = 0;
  const gate = new UpstoxRequestGate(() => now, async ms => { now += ms; });
  gate.defer('user', path, 60_000);
  await assert.rejects(gate.acquire('user', path), (error: unknown) => error instanceof UpstoxRateLimitError && error.retryAfterMs === 60_000);
  await gate.acquire('other-user', path);
  await gate.acquire('user', '/v3/market-quote/ohlc');
  now = 60_000;
  await gate.acquire('user', path);
});

test('paces requests and prevents exceeding minute and 30-minute budgets', async () => {
  let now = 0;
  const gate = new UpstoxRequestGate(() => now, async ms => { now += ms; });
  for (let group = 0; group < 4; group++) {
    const start = now;
    for (let index = 0; index < 450; index++) await gate.acquire('user', path);
    assert.ok(now - start >= 11_225);
    await assert.rejects(gate.acquire('user', path), UpstoxRateLimitError);
    now += 60_000;
  }
  await assert.rejects(gate.acquire('user', path), (error: unknown) => error instanceof UpstoxRateLimitError && error.retryAfterMs > 60_000);
});

test('historical instruments share a budget instead of bypassing it via dynamic paths', async () => {
  const gate = new UpstoxRequestGate(() => 0);
  gate.defer('user', '/v3/historical-candle/NSE_EQ%7CA/minutes/5/2026-09-17/2026-09-16', 60_000);
  await assert.rejects(gate.acquire('user', '/v3/historical-candle/NSE_EQ%7CB/minutes/3/2026-09-17/2026-09-16'), UpstoxRateLimitError);
});

test('provider 429 cools down other callers without stack-error logging and recovers after reset', async context => {
  let now = 0;
  const service = new UpstoxService({ accessToken: async () => 'fixture-token' } as any, {} as any);
  (service as any).requestGate = new UpstoxRequestGate(() => now, async ms => { now += ms; });
  const response: any = { status: 429, headers: { 'retry-after': '60' }, data: { errors: [{ errorCode: 'UDAPI10005' }] } };
  const get = context.mock.method(axios, 'get', async () => { throw new AxiosError('rate limited', undefined, undefined, undefined, response); });
  const errorLog = context.mock.method((service as any).logger, 'error', () => undefined);
  const limited = (error: unknown) => error instanceof HttpException && error.getStatus() === 429 && (error.getResponse() as any).retryAfterMs === 60_000;
  await assert.rejects(service.ltp('user', 'NSE_EQ|PNB'), limited);
  await assert.rejects(service.ltp('user', 'NSE_EQ|RAILTEL'), limited);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(errorLog.mock.callCount(), 0);
  now = 60_000;
  get.mock.mockImplementation(async () => ({ data: { data: { PNB: { last_price: 118 } } } }) as any);
  assert.deepEqual(await service.ltp('user', 'NSE_EQ|PNB'), { data: { PNB: { last_price: 118 } } });
  assert.equal(get.mock.callCount(), 2);
});

test('short Retry-After is honored by the shared gate before an internal retry', async context => {
  let now = 0;
  let attempts = 0;
  const service = new UpstoxService({ accessToken: async () => 'fixture-token' } as any, {} as any);
  (service as any).requestGate = new UpstoxRequestGate(() => now, async ms => { now += ms; });
  context.mock.method(axios, 'get', async () => {
    if (++attempts === 1) throw new AxiosError('rate limited', undefined, undefined, undefined, { status: 429, headers: { 'retry-after': '1' }, data: { errors: [] } } as any);
    assert.equal(now, 1_000);
    return { data: { status: 'success' } } as any;
  });
  assert.deepEqual(await service.funds('user'), { status: 'success' });
  assert.equal(attempts, 2);
});

test('authentication errors are preserved without rate-limit retries', async context => {
  const service = new UpstoxService({ accessToken: async () => 'fixture-token' } as any, {} as any);
  const body = { errors: [{ errorCode: 'invalid-token' }] };
  const get = context.mock.method(axios, 'get', async () => { throw new AxiosError('unauthorized', undefined, undefined, undefined, { status: 401, headers: {}, data: body } as any); });
  context.mock.method((service as any).logger, 'error', () => undefined);
  await assert.rejects(service.funds('user'), (error: unknown) => error instanceof HttpException && error.getStatus() === 401 && error.getResponse() === body);
  assert.equal(get.mock.callCount(), 1);
});
