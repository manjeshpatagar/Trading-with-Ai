import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeMarketTimestamp } from './market.gateway';

test('normalizes Upstox timestamps to epoch milliseconds', () => {
  assert.equal(normalizeMarketTimestamp(1_786_688_400), 1_786_688_400_000);
  assert.equal(normalizeMarketTimestamp(1_786_688_400_123), 1_786_688_400_123);
  assert.equal(normalizeMarketTimestamp('1786688400123000'), 1_786_688_400_123);
});

test('uses the feed receipt time when provider timestamp is unavailable', () => {
  assert.equal(normalizeMarketTimestamp(undefined, 1_786_688_400_456), 1_786_688_400_456);
});

test('Nifty scoped snapshot never invents previous close or daily OHLC from an LTP-only response', async () => {
  const { MarketGateway } = await import('./market.gateway');
  const { MarketPricesService } = await import('./market-prices.service');
  const key = 'NSE_INDEX|Nifty 50';
  const timestamp = Date.now();
  const gateway = new MarketGateway({ltp: async () => ({data: {[key]: {last_price: 100, last_trade_time: timestamp}}})} as never, {} as never, {processTick: async () => []} as never, {processTick: async () => false} as never, new MarketPricesService());
  gateway.server = {to: () => ({emit: () => {}})} as never;
  await (gateway as unknown as {fallbackToLtp(userId: string, reason: string, keys: string[]): Promise<void>}).fallbackToLtp('nifty-test', 'isolated quote fixture', [key]);
  const snapshot = gateway.latestUserSnapshot('nifty-test', key)!;
  assert.equal(snapshot.ltp, 100);
  assert.equal(snapshot.timestampTrusted, true);
  assert.equal(snapshot.close, null);
  assert.equal(snapshot.open, null);
  assert.equal(snapshot.high, null);
  assert.equal(snapshot.low, null);
  gateway.onModuleDestroy();
});
