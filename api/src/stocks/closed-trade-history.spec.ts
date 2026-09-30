import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClosedTradeHistoryService, estimateCharges, namedIstRange } from './closed-trade-history.service';

const order = (id: string, side: 'BUY' | 'SELL', exitTime: string, exitReason: string, entryPrice: number, exitPrice: number) => ({
  id, userId: 'u1', portfolio: 'STRATEGY', status: 'CLOSED', symbol: id, side,
  entryTime: new Date(new Date(exitTime).getTime() - 60_000), exitTime: new Date(exitTime),
  entryPrice, exitPrice, quantity: 10, budget: 1000, exitReason, durationMinutes: 1,
  grossPnl: null, entryBrokerage: null, exitBrokerage: null, otherCharges: null,
  totalCharges: null, netPnl: null, chargesSource: null,
});

test('IST presets include complete calendar periods', () => {
  const at = new Date('2026-09-28T06:00:00Z');
  assert.deepEqual(namedIstRange('today', at), { start: '2026-09-28', end: '2026-09-28' });
  assert.deepEqual(namedIstRange('last-week', at), { start: '2026-09-21', end: '2026-09-27' });
  assert.deepEqual(namedIstRange('last-month', at), { start: '2026-08-01', end: '2026-08-31' });
});

test('charge estimate splits entry and exit brokerage and includes statutory charges', () => {
  const fees = estimateCharges(100, 110, 10);
  assert.equal(fees.entryBrokerage, 1);
  assert.equal(fees.exitBrokerage, 1.1);
  assert.ok(fees.otherCharges > 0);
  assert.equal(fees.totalCharges, Math.round((fees.brokerage + fees.otherCharges) * 100) / 100);
});

test('report handles BUY and SELL P&L, filters exits, paginates, and emits zero-trade days', async () => {
  const stored = [
    order('BUYWIN', 'BUY', '2026-09-28T05:00:00Z', 'TARGET 3', 100, 110),
    order('SELLWIN', 'SELL', '2026-09-30T05:00:00Z', 'MANUAL EXIT', 110, 100),
    order('STOPPED', 'BUY', '2026-09-30T06:00:00Z', 'STOP LOSS', 100, 90),
  ];
  const previous = order('PREVIOUS', 'BUY', '2026-09-27T05:00:00Z', 'TARGET 3', 100, 105);
  const prisma = { paperOrder: { findMany: async (args: any) => args.where.exitTime.gte ? stored : [previous, ...stored] }, paperTradingAccount: { findUnique: async () => ({ startingBalance: 10_000 }) } } as never;
  const service = new ClosedTradeHistoryService(prisma);
  const report = await service.report('u1', { start: '2026-09-28', end: '2026-09-30', page: '1', pageSize: '2', export: 'true' });
  assert.equal(report.summary.totalTrades, 3);
  assert.equal(report.rows.length, 2);
  assert.equal(report.pagination.pages, 2);
  assert.equal(report.daily.length, 3);
  assert.equal(report.daily[1].totalTrades, 0);
  const previousNet = 50 - estimateCharges(100, 105, 10).totalCharges;
  assert.equal(report.summary.openingBalance, 10_000 + previousNet);
  assert.equal(report.summary.closingBalance, report.summary.openingBalance + report.allRows.reduce((total, row) => total + row.netPnl, 0));
  assert.equal(report.daily[0].openingBalance, report.summary.openingBalance);
  assert.equal(report.daily.at(-1)!.closingBalance, report.summary.closingBalance);
  assert.ok(report.allRows.find(row => row.id === 'BUYWIN')!.grossPnl > 0);
  assert.ok(report.allRows.find(row => row.id === 'SELLWIN')!.grossPnl > 0);

  const stopped = await service.report('u1', { start: '2026-09-28', end: '2026-09-30', reason: 'STOPLOSS' });
  assert.deepEqual(stopped.rows.map(row => row.id), ['STOPPED']);
});

test('empty report remains valid and contains each requested calendar day', async () => {
  const service = new ClosedTradeHistoryService({ paperOrder: { findMany: async () => [] }, paperTradingAccount: { findUnique: async () => ({ startingBalance: 10_000 }) } } as never);
  const report = await service.report('u1', { start: '2026-09-28', end: '2026-09-29' });
  assert.equal(report.summary.totalTrades, 0);
  assert.equal(report.summary.netPnl, 0);
  assert.deepEqual(report.daily.map(day => day.totalTrades), [0, 0]);
});
