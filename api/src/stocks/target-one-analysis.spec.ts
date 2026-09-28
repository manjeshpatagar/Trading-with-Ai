import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { analyzeTargetOne, TargetOneSignal } from './target-one-analysis';
import { SignalHistoryService } from './signal-history.service';

const at = new Date('2026-09-15T12:00:00+05:30');
const time = (value: string) => new Date(`2026-09-15T${value}+05:30`);
const signal = (changes: Partial<TargetOneSignal> = {}): TargetOneSignal => ({
  id: 'a', instrumentKey: 'NSE_EQ|A', symbol: 'STOCKA', stockName: 'Stock A', side: 'BUY',
  entryTriggeredAt: time('09:30:00'), entryPrice: 100, target1: 110,
  target1At: time('10:00:00'), target1HitAt: null, target1ExecutedPrice: 111,
  stopLossAt: null, stopLossHitAt: null, stopLoss: 95,
  completedAt: time('11:00:00'), exitPrice: 120, status: 'COMPLETED', events: [], ...changes,
});

test('classifies from T1 level, reverses SELL returns, and keeps open/missing results separate', () => {
  const report = analyzeTargetOne([
    signal(),
    signal({ id: 'buy-loss', exitPrice: 105 }), // Profitable from entry, loss from T1.
    signal({ id: 'sell-win', side: 'SELL', entryPrice: 120, exitPrice: 100 }),
    signal({ id: 'sell-loss', side: 'SELL', entryPrice: 120, exitPrice: 115 }),
    signal({ id: 'flat', exitPrice: 110 }),
    signal({ id: 'open', completedAt: null }),
    signal({ id: 'unknown', exitPrice: null }),
    signal({ id: 'invalid-level', target1: 0 }),
    signal(),
  ], at);
  assert.deepEqual(report.summary, { reachedTarget1: 8, stocks: 1, stopLossHits: 0, completed: 7, wins: 2, losses: 2, breakeven: 1, running: 1, unknown: 2 });
  assert.equal(report.rows.find(row => row.id === 'buy-loss')?.outcome, 'LOSS');
  assert.equal(report.rows.find(row => row.id === 'sell-win')?.outcome, 'WIN');
  assert.equal(report.rows[0].profitPercent, 100 / 11);
  assert.equal(report.rows[0].minutesAfterTarget1, 60);
});

test('counts stops only after T1 and retains a recovered touch on a winning trade', () => {
  const rows = analyzeTargetOne([
    signal({ id: 'stop-exit', stopLossAt: time('10:20:00'), completedAt: time('10:20:00'), exitPrice: 105, status: 'STOPLOSS_CONFIRMED' }),
    signal({ id: 'recovered', events: [
      { type: 'STOPLOSS_TOUCHED', eventTime: time('09:45:00'), executedPrice: 99 },
      { type: 'STOPLOSS_TOUCHED', eventTime: time('10:10:00'), executedPrice: 108 },
    ] }),
    signal({ id: 'early-stop', stopLossAt: time('09:45:00') }),
    signal({ id: 'future-stop', stopLossAt: time('12:01:00') }),
  ], at);
  assert.equal(rows.summary.stopLossHits, 2);
  assert.equal(rows.rows.find(row => row.id === 'stop-exit')?.stopLossHitPrice, 105);
  assert.equal(rows.rows.find(row => row.id === 'stop-exit')?.exitReason, 'STOP LOSS');
  const recovered = rows.rows.find(row => row.id === 'recovered')!;
  assert.equal(recovered.stopLossAt, time('10:10:00').toISOString());
  assert.equal(recovered.stopLossHitPrice, 108);
  assert.equal(recovered.outcome, 'WIN');
});

test('uses IST monthly entry dates, excludes future events and falls back to recorded T1 events', () => {
  const report = analyzeTargetOne([
    signal({ id: 'month-start', entryTriggeredAt: new Date('2026-08-17T00:00:00+05:30') }),
    signal({ id: 'old', entryTriggeredAt: new Date('2026-08-16T23:59:59+05:30') }),
    signal({ id: 'no-entry', entryTriggeredAt: null }),
    signal({ id: 'no-t1', target1At: null }),
    signal({ id: 'future-t1', target1At: time('12:01:00') }),
    signal({ id: 'future-exit', completedAt: time('12:01:00') }),
    signal({ id: 'fallback', target1At: null, target1ExecutedPrice: null, events: [{ type: 'TARGET1_HIT', eventTime: time('10:15:00'), executedPrice: 112 }] }),
  ], at);
  assert.equal(report.summary.reachedTarget1, 3);
  assert.equal(report.rows.find(row => row.id === 'future-exit')?.exitPrice, null);
  assert.equal(report.rows.find(row => row.id === 'fallback')?.target1At, time('10:15:00').toISOString());
  assert.equal(report.rows.find(row => row.id === 'fallback')?.target1ObservedPrice, 112);
});

test('service scopes results to the authenticated user and the existing monthly strategy queue', async () => {
  const service = new SignalHistoryService({ paperOrder: { findMany: async () => [] }, aiSignal: { findMany: async ({ where, select }: any) => {
    assert.equal(where.userId, 'user-a');
    assert.deepEqual(where.strategyResult, { isNot: null });
    assert.equal(where.aiStrategyListedAt, undefined);
    assert.equal(where.OR, undefined);
    assert.equal(where.entryTriggeredAt.gte.toISOString(), '2026-08-16T18:30:00.000Z');
    assert.deepEqual(where.side.in, ['BUY', 'SELL']);
    assert.ok(select.events.where.type.in.includes('STOPLOSS_TOUCHED'));
    return [signal()];
  } } } as any, {} as any);
  assert.equal((await service.targetOneAnalysis('user-a', at)).summary.wins, 1);
});
