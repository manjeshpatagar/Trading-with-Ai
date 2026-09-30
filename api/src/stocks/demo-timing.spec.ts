import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SignalHistoryService } from './signal-history.service';
import { PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { MarketGateway } from './market.gateway';
import { DemoTradingWorkerService } from './demo-trading-worker.service';

test('ordinary ticks check positions once; new fills check again for same-tick exits', async () => {
  for (const filled of [false, true]) {
    let checks = 0;
    const gateway = new MarketGateway({} as never, {} as never,
      { processTick: async () => filled ? [{ id: 'new-fill' }] : [] } as never,
      { processTick: async () => { checks++; return false; }, captureTriggeredDemoSignals: async () => filled } as never);
    (gateway as any).server = { to: () => ({ emit: () => undefined }) };
    await (gateway as any).processTradingTick('u', 'key', 105, Date.now(), 'websocket');
    assert.equal(checks, filled ? 2 : 1);
  }
});

test('new BUY and SELL setups already beyond Target 1 are never created', async () => {
  for (const side of ['BUY', 'SELL']) {
    let creates = 0;
    const service = new SignalHistoryService({ aiSignal: {
      findFirst: async () => null, create: async () => { creates++; },
    } } as never, {} as never);
    (service as any).persistStrategyList = async () => ({});
    (service as any).decorate = async (_user: string, rows: unknown[]) => rows;
    const buy = side === 'BUY';
    await service.recordScannerSignals('u', [{ tags: [], indicators: {}, universeRank: 1, price: 100, signal: side, instrumentKey: 'key', entry: 100,
      stopLoss: buy ? 95 : 105, target1: buy ? 101 : 99, target2: buy ? 102 : 98, target3: buy ? 103 : 97, riskReward: 2,
    }] as never, () => buy ? 104 : 96);
    assert.equal(creates, 0);
  }
});

test('ticks wait for list publication before loading newly created signals', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let loaded = false;
  const service = new SignalHistoryService({ aiSignal: { findMany: async () => { loaded = true; return []; } } } as never, {} as never);
  const publication = (service as any).publishSerial('u', () => pending);
  const tick = service.processTick('u', 'key', 100);
  await Promise.resolve();
  assert.equal(loaded, false);
  release();
  await publication;
  await tick;
  assert.equal(loaded, true);
});

test('strategy stop loss exits on its price tick even with AI wait enabled', async () => {
  for (const side of ['BUY', 'SELL']) {
    const order = { id: 'order', instrumentKey: 'key', portfolio: 'STRATEGY', side, entryPrice: 100, quantity: 10, target: side === 'BUY' ? 110 : 90, stopLoss: side === 'BUY' ? 95 : 105 };
    const service = new PaperTradingService({
      paperTradingAccount: { findMany: async () => [{ portfolio: 'STRATEGY', enabled: true, allowAiWait: true }] },
      paperOrder: { findMany: async () => [order] },
    } as never, new PaperOrderExecutionService());
    const exits: any[] = [];
    (service as any).close = async (...args: any[]) => exits.push(args);
    assert.equal(await service.processTick('u', 'key', order.stopLoss, new Date('2026-09-23T10:00:00+05:30')), true);
    assert.equal(exits[0][2], 'STOP LOSS');
  }
});


test('background price refresh watches strategy lists and independent signal-history candidates', async () => {
  const requested: string[][] = [];
  const worker = new DemoTradingWorkerService({
    paperTradingAccount: { findMany: async () => [{ userId: 'u' }, { userId: 'u' }] },
    paperOrder: { findMany: async () => [] },
    aiSignal: { findMany: async ({ where }: any) => {
      assert.equal(where.userId, 'u');
      assert.deepEqual(where.AND, [{ OR: [{ target1At: null }, { top100Selected: true }] }]);
      assert.deepEqual(where.niftyContext, { is: null });
      assert.equal(where.aiStrategyListed, undefined);
      assert.deepEqual(where.OR, [{ aiStrategyListed: true }, { aiStrategyListedAt: { not: null } }, { top100Selected: true }]);
      assert.equal(where.signalTime.lt.getTime() - where.signalTime.gte.getTime(), 86_400_000);
      return [{ instrumentKey: 'HINDCOPPER' }];
    } },
  } as never, {} as never, { refreshPrices: async (_user: string, keys: string[]) => requested.push(keys) } as never, {} as never);
  await worker.refreshOpenPositionPrices();
  assert.deepEqual(requested, [['HINDCOPPER']]);
});

test('open-position quotes finish processing before next-entry candidates are polled', async () => {
  const requested: string[][] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let queriedCandidates = false;
  const worker = new DemoTradingWorkerService({
    paperTradingAccount: { findMany: async () => [{ userId: 'u' }] },
    paperOrder: { findMany: async () => [{ instrumentKey: 'OPEN' }] },
    aiSignal: { findMany: async () => {
      queriedCandidates = true;
      return [{ instrumentKey: 'NEXT' }, { instrumentKey: 'OPEN' }];
    } },
  } as never, {} as never, { refreshPrices: async (_user: string, keys: string[]) => {
    requested.push(keys);
    if (keys.includes('OPEN')) { started(); await pending; }
  } } as never, {} as never);
  const refresh = worker.refreshOpenPositionPrices();
  await ready;
  assert.equal(queriedCandidates, false);
  assert.deepEqual(requested, [['OPEN']]);
  release();
  await refresh;
  assert.deepEqual(requested, [['OPEN'], ['NEXT']]);
});

test('one-minute candle recovery closes a strategy demo at a missed target barrier', async () => {
  const at = new Date('2026-09-28T14:52:00+05:30');
  const order = { id: 'order', portfolio: 'STRATEGY', instrumentKey: 'key', symbol: 'ARSSBL', side: 'BUY', entryTime: new Date('2026-09-28T14:46:45+05:30'), entryPrice: 504.25, quantity: 10, target: 505.21, stopLoss: 499.2 };
  const service = new PaperTradingService({ paperOrder: { findMany: async () => [order] } } as never, new PaperOrderExecutionService());
  const exits: any[] = [];
  (service as any).close = async (...args: any[]) => exits.push(args);
  assert.equal(await service.processCandleRange('u', 'key', 505.3, 503.65, at), true);
  assert.deepEqual(exits[0].slice(0, 4), ['order', 505.21, 'TARGET', at]);
});

test('signal candle recovery advances the AI lifecycle using the favorable candle extreme', async () => {
  const at = new Date('2026-09-28T14:52:00+05:30');
  const service = new SignalHistoryService({ aiSignal: { findMany: async () => [{ side: 'BUY', entryTriggeredAt: new Date(), runningAt: new Date(), target1At: new Date(), target1: 502.95, stopLoss: 499.2 }] } } as never, {} as never);
  let recovered = 0;
  (service as any).processTick = async (_user: string, _key: string, price: number) => { recovered = price; return [{ id: 'signal' }]; };
  const rows = await service.processCandleRange('u', 'key', 505.3, 503.65, at);
  assert.equal(recovered, 505.3);
  assert.equal(rows.length, 1);
});
