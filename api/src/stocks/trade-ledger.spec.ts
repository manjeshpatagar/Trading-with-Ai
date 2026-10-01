import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { LedgerTrade, summarizeLedger } from './trade-ledger';
const row = (id: string, netPnl: number): LedgerTrade => ({ id, symbol: 'X', side: 'BUY', status: 'CLOSED', quantity: 10, entryPrice: 100, exitPrice: 101,
  entryTime: new Date('2026-09-16T05:00:00Z'), exitTime: new Date('2026-09-16T05:10:00Z'), pnl: 10, netPnl, riskAmount: 10 });
test('ledger statistics count finalized fills and net results, never running target hits', () => {
  const results = summarizeLedger([row('1', 20), row('2', -5), row('3', -10), { ...row('4', 100), status: 'OPEN', exitTime: null }, { ...row('5', 100), entryTime: null }], 100);
  assert.equal(results.completedTrades, 3);
  assert.equal(results.runningTrades, 1);
  assert.equal(results.netPnl, 5);
  assert.equal(results.winners, 1);
  assert.equal(results.losers, 2);
  assert.equal(results.profitFactor, 20 / 15);
  assert.equal(results.maxDrawdown, 15);
  assert.equal(results.maxDrawdownPercent, 12.5);
  assert.equal(results.maxConsecutiveLosses, 2);
  assert.equal(results.averageHoldingMinutes, 10);
  assert.equal(results.byDirection.BUY.netPnl, 5);
});
test('empty ledger has no fabricated win rate or profit factor', () => {
  const results = summarizeLedger([], 10000);
  assert.equal(results.winRate, null);
  assert.equal(results.profitFactor, null);
  assert.equal(results.expectancy, null);
});
