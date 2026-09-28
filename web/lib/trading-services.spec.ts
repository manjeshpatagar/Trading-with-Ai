import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { tradeHistoryService } from './trading-services';

test('history date filters use IST midnight even when browser runs in UTC', () => {
  const now = new Date('2026-09-22T00:15:00+05:30');
  const orders = [
    { side: 'BUY', exitTime: '2026-09-21T23:59:59+05:30' },
    { side: 'BUY', exitTime: '2026-09-22T00:00:00+05:30' },
    { side: 'BUY', exitTime: '2026-09-23T00:00:00+05:30' },
  ];
  assert.deepEqual(tradeHistoryService.filter(orders, 'Yesterday', now), [orders[0]]);
  assert.deepEqual(tradeHistoryService.filter(orders, 'Today', now), [orders[1]]);
});
