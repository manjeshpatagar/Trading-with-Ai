import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrendPullbackStrategy, BreakoutRetestStrategy, VwapReclaimStrategy, SetupContext } from './strategy-rules';
import { MarketRegimeService } from './market-regime.service';
import { StrategySetupService } from './strategy-setup.service';
import { Candle } from './indicator.service';
const now = Date.parse('2026-09-16T10:00:00Z');
const bar = (open: number, close: number, low: number, high: number, i: number): Candle => ({ time: new Date(now - (30 - i) * 300000).toISOString(), open, close, low, high, volume: 1000 });
const mirror = (context: SetupContext): SetupContext => ({ ...context, direction: -1,
  ema20: 200 - context.ema20, ema50: 200 - context.ema50, vwap: 200 - context.vwap, previousVwap: 200 - context.previousVwap,
  candles: context.candles.map(c => ({ ...c, open: 200 - c.open, close: 200 - c.close, low: 200 - c.high, high: 200 - c.low })) });
const base = (candles: Candle[]): SetupContext => ({ candles, direction: 1, ema20: 100, ema50: 98, vwap: 99, previousVwap: 99, atr: 2, relativeVolume: 1.5 });
test('pullback requires level touch and directional confirmation symmetrically', () => {
  const context = base([bar(102, 100, 99.8, 102.2, 1), bar(100, 101, 99.9, 101.2, 2)]);
  const strategy = new TrendPullbackStrategy();
  assert.deepEqual(strategy.evaluate(context).reasons, []);
  assert.deepEqual(strategy.evaluate(mirror(context)).reasons, []);
  const missed = base([bar(103, 104, 103, 104, 1), bar(104, 105, 104, 105, 2)]);
  assert.ok(strategy.evaluate(missed).reasons.includes('PULLBACK_NOT_TOUCHED'));
  assert.ok(strategy.evaluate(mirror(missed)).reasons.includes('PULLBACK_NOT_TOUCHED'));
});
test('breakout excludes breakout/retest from its level and requires relative volume', () => {
  const prior = Array.from({ length: 20 }, (_, i) => bar(99, 99.5, 98, 100, i));
  const context = base([...prior, bar(99.5, 101, 99.5, 101.5, 20), bar(100.5, 101.2, 100.1, 101.5, 21)]);
  const strategy = new BreakoutRetestStrategy();
  assert.deepEqual(strategy.evaluate(context).reasons, []);
  assert.deepEqual(strategy.evaluate(mirror(context)).reasons, []);
  assert.ok(strategy.evaluate({ ...context, relativeVolume: null }).reasons.includes('SAME_TIME_VOLUME_UNAVAILABLE'));
  const failed = { ...context, candles: [...context.candles.slice(0, -1), bar(100.5, 99, 98.5, 101, 21)] };
  assert.ok(strategy.evaluate(failed).reasons.includes('RETEST_NOT_CONFIRMED'));
  assert.ok(strategy.evaluate(mirror(failed)).reasons.includes('RETEST_NOT_CONFIRMED'));
});
test('VWAP requires an actual cross followed by a holding confirmation in both directions', () => {
  const context = { ...base([bar(98.5, 98, 97.5, 99, 1), bar(98, 99.5, 98, 100, 2), bar(99.5, 100, 99.4, 100.5, 3)]), vwap: 99.2 };
  const strategy = new VwapReclaimStrategy();
  assert.deepEqual(strategy.evaluate(context).reasons, []);
  assert.deepEqual(strategy.evaluate(mirror(context)).reasons, []);
  assert.ok(strategy.evaluate({ ...context, previousVwap: 97 }).reasons.includes('VWAP_CROSS_MISSING'));
});
test('regime rejects missing/stale bars and setup evaluation cannot use future candles', () => {
  const candles = Array.from({ length: 100 }, (_, i) => ({ time: new Date(now - (100 - i) * 300000).toISOString(), open: 100 + i * .1, close: 100.05 + i * .1, low: 99.5 + i * .1, high: 100.5 + i * .1, volume: 1000 }));
  const regime = new MarketRegimeService();
  assert.equal(regime.classify([], now).regime, 'UNCERTAIN');
  assert.equal(regime.classify(candles, now + 900001).regime, 'UNCERTAIN');
  assert.equal(regime.classify(candles, now).regime, 'STRONG_UPTREND');
  const instrument = { symbol: 'TEST', instrumentKey: 'TEST' };
  const setup = new StrategySetupService();
  const result = setup.evaluate(instrument, candles, now, 99);
  assert.equal(result.length, 6);
  assert.deepEqual(setup.evaluate(instrument, [...candles, { ...candles.at(-1)!, time: new Date(now).toISOString(), high: 10000 }], now, 99), result);
  assert.ok(result.every(row => row.winProbability === null && row.riskValidation === 'ACCOUNT_ADMISSION_REQUIRED'));
  assert.ok(setup.evaluate(instrument, candles, now + 900001, 100).every(row => !row.eligibleSetup));
});
