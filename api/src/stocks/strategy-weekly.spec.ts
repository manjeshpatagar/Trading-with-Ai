import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { summarizeStrategyMonth, strategyHistoryRange } from './strategy-weekly';

test('monthly queue counts entries, finished outcomes and pending without duplicate signals', () => {
  const at = new Date('2026-09-10T15:30:00Z');
  const row = { id: 'win', entryTriggeredAt: new Date('2026-09-10T04:00:00Z'), completedAt: new Date('2026-09-10T08:00:00Z'), profitPercent: 2 };
  const result = summarizeStrategyMonth([row, row, { ...row, id: 'loss', profitPercent: -1 }, { ...row, id: 'flat', profitPercent: 0 }, { ...row, id: 'pending', completedAt: null }, { ...row, id: 'unknown', profitPercent: null }, { ...row, id: 'watch', entryTriggeredAt: null }], at);
  assert.equal(result.days.length, 30);
  assert.deepEqual(result.days[0], { date: '2026-09-10', entries: 5, completed: 4, wins: 1, losses: 1, breakeven: 1, pending: 1, unclassified: 1 });
  assert.equal(result.days[29].date, '2026-08-12');
  assert.equal(result.days[29].entries, 0);
});

test('uses IST entry date at midnight and excludes older and future entries', () => {
  const at = new Date('2026-09-10T18:40:00Z');
  assert.equal(strategyHistoryRange(at).start.toISOString(), '2026-08-12T18:30:00.000Z');
  const make = (id: string, date: string) => ({ id, entryTriggeredAt: new Date(date), completedAt: null, profitPercent: null });
  const result = summarizeStrategyMonth([make('today', '2026-09-10T18:30:00Z'), make('yesterday', '2026-09-10T18:29:59Z'), make('oldest', '2026-08-12T18:30:00Z'), make('old', '2026-08-12T18:29:59Z'), make('future', '2026-09-11T04:00:00Z')], at);
  assert.equal(result.days[0].date, '2026-09-11');
  assert.equal(result.days[0].entries, 1);
  assert.equal(result.days[1].entries, 1);
  assert.equal(result.days[29].entries, 1);
  assert.equal(result.days.reduce((sum, day) => sum + day.entries, 0), 3);
});

test('monthly service counts the published 20-signal queue, not all 83 previously listed signals', async () => {
  const { SignalHistoryService } = await import('./signal-history.service');
  const rows = Array.from({ length: 83 }, (_, index) => ({ id: String(index), aiStrategyListed: index < 20, entryTriggeredAt: new Date('2026-09-10T04:00:00Z'), completedAt: new Date('2026-09-10T08:00:00Z'), profitPercent: index < 15 ? 1 : -1 }));
  const prisma: any = { aiSignal: { findMany: async ({ where }: any) => {
    assert.equal(where.userId, 'user-1');
    assert.equal(where.aiStrategyListed, true);
    assert.equal(where.aiStrategyListedAt, undefined);
    return rows.filter(row => row.aiStrategyListed === where.aiStrategyListed);
  } } };
  const service = new SignalHistoryService(prisma, {} as never);
  const result = await service.strategyWeekly('user-1', new Date('2026-09-10T15:30:00Z'));
  assert.equal(result.days[0].entries, 20);
  assert.equal(result.days[0].completed, 20);
  assert.equal(result.days[0].wins, 15);
  assert.equal(result.days[0].losses, 5);
});
