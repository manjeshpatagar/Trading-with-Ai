import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { RiskManagementService } from './risk-management.service';
import { PaperOrderExecutionService, simulatedMarketPrice } from './paper-order-execution.service';
import { PaperTradingService } from './paper-trading.service';
import { estimateCharges } from './closed-trade-history.service';

const risk = new RiskManagementService();
const base = { capital: 10_000, accountBalance: 10_000, entryPrice: 100, stopLoss: 99, riskPercent: 1, leverage: 5 };
test('risk caps margin, liquidity, quantity limits and lot size for both directions', () => {
  for (const side of ['BUY', 'SELL']) {
    const input = { ...base, side, stopLoss: side === 'BUY' ? 99 : 101, target: side === 'BUY' ? 103 : 97 };
    assert.equal(risk.size(input).quantity, 100);
    assert.equal(risk.size({ ...input, capital: 100 }).quantity, 5);
    assert.equal(risk.size({ ...input, liquidityQuantity: 43, maximumQuantity: 50, lotSize: 10 }).quantity, 40);
    assert.equal(risk.size({ ...input, accountBalance: 5000 }).quantity, 50);
    assert.equal(risk.size({ ...input, stopLoss: side === 'BUY' ? 101 : 99 }).quantity, 0);
    assert.equal(risk.size({ ...input, target: side === 'BUY' ? 100.5 : 99.5 }).quantity, 0);
  }
});
test('invalid and zero risk inputs fail closed', () => {
  for (const key of ['capital', 'accountBalance', 'entryPrice', 'stopLoss', 'riskPercent', 'leverage']) {
    for (const value of [0, -1, NaN, Infinity]) assert.equal(risk.size({ ...base, [key]: value }).quantity, 0);
  }
  assert.equal(risk.size({ ...base, stopLoss: 100 }).quantity, 0);
  assert.equal(risk.size({ ...base, lotSize: 1.5 }).quantity, 0);
  assert.equal(risk.size({ ...base, maximumQuantity: -1 }).quantity, 0);
});
test('execution rejects malformed fills rather than recording a zero-price trade', async () => {
  const execution = new PaperOrderExecutionService();
  for (const price of [0, -1, NaN, Infinity]) await assert.rejects(execution.fill({ price, quantity: 1, at: new Date() }));
  await assert.rejects(execution.fill({ price: 100, quantity: 0.5, at: new Date() }));
  for (const side of ['BUY', 'SELL']) {
    const fill = await execution.close({ side, entryPrice: 100, price: side === 'BUY' ? 102 : 98, quantity: 10, reason: 'TARGET', at: new Date() });
    assert.equal(fill.pnl, 20);
    assert.equal(fill.pnlPercent, 2);
  }
});
test('account reads preserve disabled automation and customized balances', async () => {
  const saved = { enabled: false, autoDemoTrading: false, startingBalance: 9000, maxOpenTrades: 1 };
  const service = new PaperTradingService({ paperTradingAccount: { findUnique: async () => saved, upsert: async () => { throw new Error('read must not write'); } } } as never, new PaperOrderExecutionService());
  assert.equal(await service.account('u'), saved);
});
test('hard stops ignore disabled entries and AI wait for BUY and SELL', async () => {
  for (const side of ['BUY', 'SELL']) for (const portfolio of ['STRATEGY', 'SIGNAL_HISTORY']) {
    const at = new Date('2026-09-16T06:00:00Z');
    const order = { id: 'p', portfolio, instrumentKey: 'X', side, entryPrice: 100, entryTime: new Date(at.getTime() - 1000), quantity: 10, stopLoss: side === 'BUY' ? 99 : 101, target: side === 'BUY' ? 104 : 96 };
    const service = new PaperTradingService({ paperOrder: { findMany: async () => [order] } } as never, new PaperOrderExecutionService());
    const exits: any[] = [];
    (service as any).close = async (...args: any[]) => exits.push(args);
    assert.equal(await service.processTick('u', 'X', side === 'BUY' ? 98 : 102, at), true);
    assert.equal(exits[0][2], 'STOP LOSS');
    assert.equal(exits[0][1], side === 'BUY' ? 98 : 102);
  }
});
test('short sale charge turnover applies sell tax to entry and buy stamp to exit', () => {
  const long = estimateCharges(100, 200, 10, 'BUY');
  const short = estimateCharges(200, 100, 10, 'SELL');
  assert.equal(short.totalCharges, long.totalCharges);
  assert.equal(short.entryBrokerage, long.exitBrokerage);
});

test('daily controls are independent of technical scores and enforce exact boundaries', () => {
  const state = { dayStartEquity: 10000, realizedPnl: 0, unrealizedPnl: 0, consecutiveLosses: 0, symbolEntries: 0, lastStopAt: null, at: 1_000_000 };
  const limits = { maxDailyLossPercent: 3, maxCombinedLossPercent: 4, maxConsecutiveLosses: 3, maxEntriesPerSymbol: 2, stopCooldownMinutes: 15, allowReentry: true };
  assert.deepEqual(risk.daily(state, limits), []);
  assert.ok(risk.daily({ ...state, realizedPnl: -300 }, limits).includes('DAILY_REALIZED_LOSS_LIMIT'));
  assert.ok(risk.daily({ ...state, realizedPnl: -100, unrealizedPnl: -300 }, limits).includes('DAILY_COMBINED_LOSS_LIMIT'));
  assert.ok(risk.daily({ ...state, consecutiveLosses: 3 }, limits).includes('CONSECUTIVE_LOSS_LIMIT'));
  assert.ok(risk.daily({ ...state, symbolEntries: 2 }, limits).includes('SYMBOL_ENTRY_LIMIT'));
  assert.ok(risk.daily({ ...state, lastStopAt: 999999 }, limits).includes('STOP_LOSS_COOLDOWN'));
  assert.deepEqual(risk.daily({ ...state, lastStopAt: 100000 }, limits), []);
  assert.ok(risk.daily({ ...state, symbolEntries: 1 }, { ...limits, allowReentry: false }).includes('SYMBOL_ENTRY_LIMIT'));
});

test('slippage and assumed half-spread are adverse on both entry and exit', () => {
  assert.ok(Math.abs(simulatedMarketPrice(100, 'BUY', 10, 4) - 100.12) < 1e-9);
  assert.ok(Math.abs(simulatedMarketPrice(100, 'SELL', 10, 4) - 99.88) < 1e-9);
  assert.throws(() => simulatedMarketPrice(100, 'BUY', -1, 0));
});
