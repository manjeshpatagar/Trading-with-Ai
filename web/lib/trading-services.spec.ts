import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { paperTradingService, tradeHistoryService } from './trading-services';

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


test('strategy settings preserve disabled automation, entry mode and daily controls in the PATCH body', async (t) => {
  const settings = { enabled: true, autoDemoTrading: false, riskPerTrade: .5, entryMode: 'ORIGINAL_SIGNAL', maxDailyLossPercent: 3, maxCombinedLossPercent: 4, maxConsecutiveLosses: 3, maxEntriesPerSymbol: 2, stopCooldownMinutes: 15 };
  let captured: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.match(String(url), /paper-trading\/settings$/);
    captured = init;
    return new Response(JSON.stringify({ ...settings, configurationVersion: 2 }));
  });
  const response = await paperTradingService.updateSettings(settings) as { configurationVersion: number };
  assert.equal(captured?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(captured?.body)), settings);
  assert.equal(response.configurationVersion, 2);
});
test('a rejected settings write is exposed to the caller, never reported as saved', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'Invalid entryMode' }), { status: 400 }));
  await assert.rejects(paperTradingService.updateSettings({ entryMode: 'INVALID' }), /Invalid entryMode/);
});
