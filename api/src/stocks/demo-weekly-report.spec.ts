import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { demoWeeklyReport } from './demo-weekly-report';
import { PaperTradingService } from './paper-trading.service';

const at = new Date('2026-09-15T12:00:00+05:30');
const order = (changes: Record<string, unknown> = {}): any => ({
  id: 'a', userId: 'user-a', portfolio: 'SIGNAL_HISTORY', signalId: 'signal-a', instrumentKey: 'NSE_EQ|A', symbol: 'STOCKA', side: 'SELL',
  status: 'CLOSED', entryTime: new Date('2026-09-15T10:00:00+05:30'), exitTime: new Date('2026-09-15T11:00:00+05:30'),
  entryPrice: 110, exitPrice: 105, currentPrice: 105, target: 105, stopLoss: 115, quantity: 20, pnl: 100, pnlPercent: 4.54545, exitReason: 'TARGET', updatedAt: at, ...changes,
});
const signal: any = { id: 'signal-a', stockName: 'Stock A Limited', target1: 111, target2: 107, target3: 105, target1At: new Date('2026-09-15T09:59:00+05:30'), target1HitAt: null, target1ExecutedPrice: 110 };

test('groups seven IST dates, counts executions once, and separates realized and open P&L', () => {
  const report = demoWeeklyReport([
    order(), order(), order({ id: 'loss', pnl: -50, exitReason: 'STOPLOSS', exitPrice: 112.5 }),
    order({ id: 'open', status: 'OPEN', exitTime: null, pnl: 25 }),
    order({ id: 'prior', entryTime: new Date('2026-09-14T23:59:59+05:30'), pnl: 0 }),
    order({ id: 'old', entryTime: new Date('2026-09-08T23:59:59+05:30') }),
    order({ id: 'other-portfolio', portfolio: 'STRATEGY' }), order({ id: 'waiting', status: 'WAITING', entryTime: null }),
  ], [signal], at);
  assert.equal(report.days.length, 7);
  assert.equal(report.days[0].date, '2026-09-15');
  assert.equal(report.days[1].date, '2026-09-14');
  assert.equal(report.days[6].date, '2026-09-09');
  assert.equal(report.days[0].rows.length, 3);
  assert.equal(report.summary.trades, 4);
  assert.equal(report.summary.wins, 1);
  assert.equal(report.summary.losses, 1);
  assert.equal(report.summary.breakeven, 1);
  assert.equal(report.summary.running, 1);
  assert.equal(report.summary.realizedProfit, 100);
  assert.equal(report.summary.realizedLoss, 50);
  assert.equal(report.summary.realizedPnl, 50);
  assert.equal(report.summary.unrealizedPnl, 25);
  assert.equal(report.rows.find(row => row.id === 'open')?.outcome, 'RUNNING');
});

test('uses exact linked signals and preserves missing history without inventing target times', () => {
  const report = demoWeeklyReport([order(), order({ id: 'missing', signalId: 'deleted' })], [signal], at);
  assert.equal(report.rows[0].stockName, 'Stock A Limited');
  assert.equal(report.rows[0].target1At, signal.target1At.toISOString());
  assert.equal(report.rows[0].profitAmount, 100);
  assert.equal(report.rows[1].target1At, null);
  assert.equal(report.rows[1].target1Price, null);
  assert.equal(report.rows[1].stockName, 'STOCKA');
});

test('report query is read-only, scoped to user and demo portfolio, and does not truncate history', async () => {
  const prisma: any = {
    paperOrder: { findMany: async (args: any) => {
      assert.equal(args.where.userId, 'user-a'); assert.equal(args.where.portfolio, 'SIGNAL_HISTORY');
      assert.equal(args.take, undefined);
      assert.equal(args.where.entryTime.gte.toISOString(), '2026-09-08T18:30:00.000Z');
      return [order()];
    } },
    aiSignal: { findMany: async (args: any) => {
      assert.equal(args.where.userId, 'user-a'); assert.deepEqual(args.where.id.in, ['signal-a']); return [signal];
    } },
  };
  const service = new PaperTradingService(prisma, {} as any);
  assert.equal((await service.signalHistoryWeeklyReport('user-a', at)).summary.trades, 1);
});
