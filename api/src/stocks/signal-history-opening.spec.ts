import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SignalHistoryService } from './signal-history.service';

const at = (time: string) => new Date(`2026-09-16T${time}+05:30`);

test('history creates BUY and SELL signals only from 09:20 IST, including pre-market requests', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('09:11:00') });
  for (const side of ['BUY', 'SELL']) {
    const created: any[] = [];
    const service = new SignalHistoryService({ aiSignal: {
      findFirst: async () => null,
      create: async ({ data }: any) => { created.push(data); return { ...data, id: side }; },
    } } as never, {} as never);
    (service as any).persistStrategyList = async () => ({});
    const buy = side === 'BUY';
    const row = { signal: side, tags: [], indicators: {}, universeRank: 1, price: 100, instrumentKey: side,
      entry: 100, stopLoss: buy ? 95 : 105, target1: buy ? 105 : 95,
      target2: buy ? 110 : 90, target3: buy ? 115 : 85, riskReward: 3 };
    for (const time of ['09:11:00', '09:15:00', '09:19:59.999']) {
      t.mock.timers.setTime(at(time).getTime());
      await service.recordScannerSignals('u', [row] as never);
      assert.equal(created.length, 0);
    }
    t.mock.timers.setTime(at('09:20:00').getTime());
    await service.recordScannerSignals('u', [row] as never);
    assert.equal(created.length, 1);
    assert.equal(created[0].side, side);
  }
});

test('waiting history signals cannot enter before 09:20 and can enter at the boundary', async () => {
  for (const side of ['BUY', 'SELL']) {
    const signal = { id: side, side, instrumentKey: side, status: 'WAITING', signalTime: at('09:11:00'),
      entryPrice: 100, stopLoss: side === 'BUY' ? 95 : 105,
      target1: side === 'BUY' ? 105 : 95, target2: side === 'BUY' ? 110 : 90, target3: side === 'BUY' ? 115 : 85 };
    const service = new SignalHistoryService({
      aiSignal: { update: async () => ({}), updateMany: async () => ({}) },
      aiTradeEvent: { upsert: async () => ({}) }, $transaction: async (items: any[]) => Promise.all(items),
    } as never, {} as never);
    (service as any).activeCache.set(`u:${side}`, [signal]);
    for (const time of ['09:11:00', '09:15:00', '09:19:59.999']) {
      assert.deepEqual(await service.processTick('u', side, 100, at(time)), []);
      assert.equal(signal.status, 'WAITING');
    }
    const entered = await service.processTick('u', side, 100, at('09:20:00'));
    assert.equal(entered[0].status, 'ENTRY_TRIGGERED');
    assert.equal(entered[0].entryTriggeredAt.toISOString(), at('09:20:00').toISOString());
  }
});
