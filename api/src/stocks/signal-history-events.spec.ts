import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { compareTargetOneHits, confirmedTargetOneTime, mergeHistoryUpdate } from './signal-history-events';
import { SignalHistoryService } from './signal-history.service';
import { MarketGateway } from './market.gateway';

const at = (time: string) => new Date(`2026-09-16T${time}+05:30`);
const event = (time: string, type = 'TARGET1_HIT') => ({ id: type, type, eventTime: at(time), triggerPrice: 105, executedPrice: 105, profitPercent: 5, holdingMinutes: 1 });
const row = (id: string, events: ReturnType<typeof event>[] = []) => ({ id, instrumentKey: id, signalTime: at('09:30:00'), currentPrice: 100, status: 'RUNNING', events });

test('only confirmed event times give priority, newest hit first regardless of stale scalar fields', () => {
  const old = { ...row('old', [event('10:00:00')]), target1At: at('12:00:00'), updatedAt: at('12:00:00') };
  const recent = { ...row('recent', [event('11:59:12')]), target1At: at('09:40:00') };
  const unconfirmed = { ...row('unconfirmed'), target1At: at('12:01:00'), status: 'TARGET1_HIT' };
  const invalid = row('invalid', [{ ...event('10:00:00'), eventTime: new Date('invalid') }]);
  const signals = [unconfirmed, old, invalid, recent, row('waiting')];
  assert.deepEqual(signals.sort(compareTargetOneHits).map(item => item.id), ['recent', 'old', 'unconfirmed', 'invalid', 'waiting']);
  assert.equal(confirmedTargetOneTime(recent), at('11:59:12').toISOString());
  assert.equal(confirmedTargetOneTime(unconfirmed), null);
  assert.equal(confirmedTargetOneTime(invalid), null);
});

test('live event updates immediately reorder and subsequent partial or duplicate updates retain the hit time', () => {
  let signals = [row('old', [event('10:00:00')]), row('new')];
  const update = { ...row('new', [event('11:59:00')]), status: 'TARGET1_HIT' };
  signals = mergeHistoryUpdate(signals, [update]);
  assert.equal(signals[0].id, 'new');
  signals = mergeHistoryUpdate(signals, [update, { ...row('new', [event('12:00:00', 'TARGET2_HIT')]), status: 'TARGET2_HIT' }]);
  assert.equal(signals[0].id, 'new');
  assert.equal(signals[0].events.filter(item => item.type === 'TARGET1_HIT').length, 1);
  assert.equal(confirmedTargetOneTime(signals[0]), at('11:59:00').toISOString());
});

test('HTTP history sorts by recorded database events even when cached signal timestamps and events disagree', async () => {
  const rows = [row('old', [event('10:00:00')]), row('new', [event('11:59:00')]), row('none')];
  const service = new SignalHistoryService({ aiSignal: { findMany: async () => rows } } as never, {} as never);
  (service as any).activeCache.set('u:old', [{ ...rows[0], target1At: at('12:00:00'), events: [event('12:00:00')] }]);
  const result = await service.history('u');
  assert.deepEqual(result.signals.map(item => item.id), ['new', 'old', 'none']);
  assert.equal(confirmedTargetOneTime(result.signals[1]), at('10:00:00').toISOString());
});

test('lifecycle payload includes committed event timestamps and retains Target 1 on later target updates', async () => {
  const signal = { ...row('stock'), side: 'BUY', entryPrice: 100, entryTriggeredAt: at('09:35:00'), runningAt: at('09:35:01'), stopLoss: 95, target1: 105, target2: 110, target3: 115 };
  const recorded = new Map<string, any>();
  // Simulate an already persisted event returned by an idempotent upsert.
  recorded.set('TARGET1_HIT', event('11:59:17'));
  const service = new SignalHistoryService({
    aiSignal: { findFirst: async () => null, update: async ({ data }: any) => ({ ...signal, ...data }) },
    aiTradeEvent: { upsert: async ({ create }: any) => {
      if (!recorded.has(create.type)) recorded.set(create.type, { id: create.type, ...create });
      return recorded.get(create.type);
    } },
    demoTradeQueue: { upsert: async ({ create }: any) => create },
    $transaction: async (items: any[]) => Promise.all(items),
  } as never, {} as never);
  (service as any).activeCache.set('u:stock', [signal]);
  const first = await service.processTick('u', 'stock', 105, at('12:00:00'));
  assert.equal(confirmedTargetOneTime(first[0]), at('11:59:17').toISOString());
  const second = await service.processTick('u', 'stock', 110, at('12:01:00'));
  assert.equal(confirmedTargetOneTime(second[0]), at('11:59:17').toISOString());
  assert.ok(second[0].events.some((item: any) => item.type === 'TARGET2_HIT'));
});

test('WebSocket publishes confirmed events without waiting for demo execution', async () => {
  const trades = [row('new', [event('11:59:00')])];
  const sent: any[] = [];
  const gateway = new MarketGateway({} as never, {} as never,
    { processTick: async () => trades } as never,
    { processTick: async () => false, captureTriggeredDemoSignals: async () => {
      assert.equal(sent[0].name, 'signal-history-updated');
      throw new Error('demo unavailable');
    } } as never);
  (gateway as any).server = { to: () => ({ emit: (name: string, payload: any) => sent.push({ name, payload }) }) };
  await (gateway as any).processTradingTick('u', 'new', 105, at('11:59:00').getTime(), 'websocket');
  assert.equal(sent.length, 1);
  assert.equal(confirmedTargetOneTime(sent[0].payload.trades[0]), at('11:59:00').toISOString());
});

test('history and detail reads keep committed completion over a stale lifecycle cache', async () => {
  const stored = { ...row('finished', [event('12:00:00', 'COMPLETED')]), status: 'COMPLETED', completedAt: at('12:00:00'), target3At: at('12:00:00') };
  const service = new SignalHistoryService({ aiSignal: { findMany: async () => [stored], findFirst: async () => stored } } as never, {} as never);
  (service as any).activeCache.set('u:finished', [{ ...stored, status: 'TARGET1_HIT', completedAt: null, target3At: null }]);
  assert.equal((await service.history('u')).signals[0].status, 'COMPLETED');
  assert.equal((await service.one('u', 'finished'))?.status, 'COMPLETED');
});

test('a pullback cannot downgrade Target 2, and final target completes BUY and SELL signals', async () => {
  for (const side of ['BUY', 'SELL']) {
    const buy = side === 'BUY';
    const signal = { ...row('stock', [event('10:00:00'), event('10:01:00', 'TARGET2_HIT')]), side,
      status: 'TARGET2_HIT', entryPrice: 100, entryTriggeredAt: at('09:35:00'), runningAt: at('09:35:01'),
      stopLoss: buy ? 95 : 105, target1: buy ? 105 : 95, target2: buy ? 110 : 90, target3: buy ? 115 : 85,
      target1At: at('10:00:00'), target2At: at('10:01:00') };
    const service = new SignalHistoryService({
      aiSignal: { update: async ({ data }: any) => ({ ...signal, ...data }) },
      aiTradeEvent: { upsert: async ({ create }: any) => ({ id: create.type, ...create }) },
      $transaction: async (items: any[]) => Promise.all(items),
    } as never, {} as never);
    (service as any).activeCache.set('u:stock', [signal]);
    (service as any).queueLivePriceWrite = () => {};
    await service.processTick('u', 'stock', buy ? 106 : 94, at('10:02:00'));
    assert.equal(signal.status, 'TARGET2_HIT');
    const [completed] = await service.processTick('u', 'stock', buy ? 116 : 84, at('10:03:00'));
    assert.equal(completed.status, 'COMPLETED');
    assert.ok(completed.events.some((item: any) => item.type === 'COMPLETED'));
  }
});

test('a committed demo exit is broadcast even when signal processing fails', async () => {
  const sent: string[] = [];
  const gateway = new MarketGateway({} as never, {} as never,
    { processTick: async () => { throw new Error('signal database unavailable'); } } as never,
    { processTick: async () => true } as never);
  gateway.server = { to: () => ({ emit: (name: string) => sent.push(name) }) } as never;
  await (gateway as any).processTradingTick('u', 'stock', 115, at('12:00:00').getTime(), 'websocket');
  assert.ok(sent.includes('paper-trading-updated'));
});
