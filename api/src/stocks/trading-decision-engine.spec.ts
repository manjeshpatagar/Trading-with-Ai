import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptiveMinimumConfidence, automaticRiskProfile, executionScore, riskBasedQuantity, strategyPriority, strictEntryDecision } from './trading-decision-engine';

const qualified = { side: 'BUY', strategy: 'ORB', confidence: 96, aiScore: 97, riskReward: 3.5, volumeRatio: 2.4, vwapAligned: true, emaAligned: true, ema200Aligned: true, volumeIncreasing: true, marketTrendAligned: true, sectorStrength: 75, finalTradingScore: 91 };

test('shared strict engine accepts a fully qualified setup', () => {
  assert.equal(strictEntryDecision(qualified).ready, true);
});

test('shared strict engine rejects AI score below the professional floor', () => {
  const result = strictEntryDecision({ ...qualified, aiScore: 74 });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'AI score below 75%');
});

test('V4 execution score uses the documented weighted formula', () => {
  assert.equal(executionScore({ ...qualified, confidence: 100, aiScore: 100, volumeRatio: 3, riskReward: 5, sectorStrength: 100 }), 100);
});

test('adaptive confidence follows the market regime table', () => {
  assert.deepEqual(['STRONG_BULLISH', 'BULLISH', 'SIDEWAYS', 'BEARISH'].map((regime) => adaptiveMinimumConfidence(regime as any)), [75, 80, 90, 95]);
});

test('quantity is sized from risk divided by stop distance and capped by margin', () => {
  assert.equal(riskBasedQuantity({ capital: 10_000, availableMargin: 10_000, entryPrice: 100, stopLoss: 98 }).quantity, 50);
  assert.equal(riskBasedQuantity({ capital: 10_000, availableMargin: 2_000, entryPrice: 100, stopLoss: 98 }).quantity, 20);
});

test('recovery mode halves risk until restored', () => {
  assert.equal(automaticRiskProfile(10_000, false).riskAmount, 100);
  assert.equal(automaticRiskProfile(10_000, true).riskAmount, 50);
});

test('five consecutive wins increase risk only slightly', () => {
  assert.equal(automaticRiskProfile(10_000, false, true).riskAmount, 110);
});

test('strategy priority is deterministic', () => {
  assert.ok(strategyPriority('ORB') > strategyPriority('Breakout'));
  assert.ok(strategyPriority('Breakout') > strategyPriority('Momentum'));
  assert.ok(strategyPriority('Momentum') > strategyPriority('VWAP Pullback'));
});
