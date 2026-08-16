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
