import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { EquityBacktest } from './equity-backtest';
import { Candle } from './indicator.service';
const at = Date.parse('2026-09-16T06:00:00Z');
const candles = (): Candle[] => Array.from({ length: 203 }, (_, i) => ({ time: new Date(at - (200 - i) * 300000).toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
const instrument = { symbol: 'X', instrumentKey: 'X' };
const setup = { eligibleSetup: true, strategyName: 'Trend Pullback', direction: 'BUY', referenceEntryPrice: 100, stopLossPrice: 98, target1: 103, target3: 106, marketDataTimestamp: new Date(at - 300000).toISOString(), expiresAt: new Date(at + 900000).toISOString(), marketRegime: { regime: 'STRONG_UPTREND' } };
test('replay uses only previous candles and resolves a stop/target ambiguity adversely', async () => {
  const rows = candles(); rows[201] = { ...rows[201], high: 108, low: 97 };
  const evaluator = { evaluate: (_instrument: unknown, history: Candle[], now: number) => {
    assert.ok(history.every(bar => Date.parse(bar.time) + 300000 <= now));
    return [setup];
  } };
  const result = await new EquityBacktest(evaluator as never, (() => ({ aiScore: 90, direction: 1 })) as never).run(instrument, rows, { slippageBps: 0, spreadBps: 0 });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, 100);
  assert.equal(result.trades[0].exitPrice, 98);
  assert.equal(result.trades[0].exitReason, 'STOP LOSS');
  assert.ok(result.trades[0].netPnl! < -50);
});
test('replay respects end cutoff and leaves unresolved positions running', async () => {
  const evaluator = { evaluate: () => [setup] };
  const rows = candles();
  const result = await new EquityBacktest(evaluator as never, (() => ({ aiScore: 90, direction: 1 })) as never).run(instrument, rows, { slippageBps: 0, spreadBps: 0, to: at + 300000 });
  assert.equal(result.performance.runningTrades, 1);
  assert.equal(result.performance.completedTrades, 0);
  assert.equal(result.performance.winRate, null);
  const mutated = [...rows.slice(0, 201), { ...rows[201], high: 10000, low: 1 }];
  assert.deepEqual(await new EquityBacktest(evaluator as never, (() => ({ aiScore: 90, direction: 1 })) as never).run(instrument, mutated, { slippageBps: 0, spreadBps: 0, to: at + 300000 }), result);
});
