import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuoteBatchService } from './quote-batch.service';

const key = (index: number) => `NSE_EQ|INE${String(index).padStart(9, '0')}`;
const responseFor = (keys: string[]) => ({
  data: Object.fromEntries(keys.map((instrumentKey, index) => [
    `NSE_EQ:SYMBOL${index}`,
    { instrument_token: instrumentKey, last_price: 100 + index, cp: 99, volume: 1_000 },
  ])),
});

test('validates, deduplicates, batches at 200, and caps concurrency at five', async () => {
  let active = 0;
  let maximumActive = 0;
  const batchSizes: number[] = [];
  const upstox = {
    ltp: async (_userId: string, joined: string, timeout: number) => {
      const keys = joined.split(',');
      assert.equal(timeout, 10_000);
      batchSizes.push(keys.length);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return responseFor(keys);
    },
  };
  const auth = { accessToken: async () => 'token' };
  const service = new QuoteBatchService(upstox as any, auth as any);
  const keys = Array.from({ length: 1_201 }, (_, index) => key(index));
  const result = await service.fetchAll('user', [...keys, null, undefined, '', 'bad', keys[0]]);

  assert.equal(result.validKeys, 1_201);
  assert.equal(result.invalidKeys.length, 5);
  assert.equal(result.received, 1_201);
  assert.equal(result.totalBatches, 7);
  assert.ok(batchSizes.every((size) => size <= 200));
  assert.ok(maximumActive <= 5);
});

test('retries a failed batch up to three times and continues with other batches', async () => {
  const attempts = new Map<string, number>();
  const upstox = {
    ltp: async (_userId: string, joined: string) => {
      const current = (attempts.get(joined) ?? 0) + 1;
      attempts.set(joined, current);
      if (joined.startsWith(key(0)) && current < 4) throw new Error('timeout');
      return responseFor(joined.split(','));
    },
  };
  const service = new QuoteBatchService(upstox as any, { accessToken: async () => 'token' } as any);
  const result = await service.fetchAll('user', Array.from({ length: 201 }, (_, index) => key(index)));

  assert.equal(attempts.get(Array.from({ length: 200 }, (_, index) => key(index)).join(',')), 4);
  assert.equal(result.received, 201);
  assert.equal(result.failedBatches, 0);
});
