import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconstructStopLossJourney, type JourneyCandle } from './stop-loss-journey.service';

const candle = (time: string, open: number, high: number, low: number, close: number): JourneyCandle => ({ time: new Date(time), open, high, low, close, volume: 1_000 });
const signal = (overrides: Record<string, unknown> = {}) => ({
  id: 'signal-1', stockName: 'Zensar Technologies Ltd', symbol: 'ZENSARTECH', side: 'BUY', strategy: 'Momentum', timeframe: '5m',
  signalTime: new Date('2026-08-03T04:00:00.000Z'), entryTriggeredAt: new Date('2026-08-03T04:01:10.000Z'),
  stopLossAt: new Date('2026-08-03T04:05:20.000Z'), entryPrice: 500, stopLoss: 495, exitPrice: 494.5,
  target1: 505, target2: 510, target3: 515, ...overrides,
});

test('reconstructs Entry → Target 1 → Stop Loss from candles before the stop minute', () => {
  const result = reconstructStopLossJourney(signal(), [
    candle('2026-08-03T04:01:00.000Z', 500, 502, 499.8, 501),
    candle('2026-08-03T04:02:00.000Z', 501, 508, 500.5, 507),
    candle('2026-08-03T04:03:00.000Z', 507, 507.2, 499.9, 500),
    candle('2026-08-03T04:05:00.000Z', 500, 510, 494, 494.5),
  ]);
  assert.equal(result.reachedTarget1, true);
  assert.equal(result.reachedTarget2, false, 'the stop candle high must not invent an intrabar target-before-stop sequence');
  assert.equal(result.highestPriceBeforeStopLoss, 508);
  assert.equal(result.journeyType, 'Entry → Target 1 → Stop Loss');
  assert.deepEqual(result.path, ['Entry', 'Target 1', 'Breakeven', 'Stop Loss']);
});

test('classifies a stop in the entry candle as Immediate Stop Loss', () => {
  const result = reconstructStopLossJourney(signal(), [candle('2026-08-03T04:05:00.000Z', 500, 506, 494, 494.5)]);
  assert.equal(result.maxProfitPercent, 0);
  assert.equal(result.journeyType, 'Immediate Stop Loss');
});

test('calculates SELL favorable and adverse movement directionally', () => {
  const result = reconstructStopLossJourney(signal({ side: 'SELL', stopLoss: 505, exitPrice: 505.5, target1: 495, target2: 490, target3: 485 }), [
    candle('2026-08-03T04:01:00.000Z', 500, 501, 498, 499),
    candle('2026-08-03T04:02:00.000Z', 499, 500, 496, 497),
    candle('2026-08-03T04:05:00.000Z', 500, 506, 494, 505.5),
  ]);
  assert.equal(result.maxProfitPercent, 0.8);
  assert.ok(Math.abs(result.stopLossPercent + 1.1) < 1e-9);
  assert.equal(result.journeyType, 'Entry → Profit → Stop Loss');
});
