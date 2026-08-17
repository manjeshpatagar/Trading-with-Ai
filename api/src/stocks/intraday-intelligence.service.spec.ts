import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntradayIntelligenceService } from './intraday-intelligence.service';

test('does not fabricate unavailable market, timeframe, liquidity, or historical evidence', () => {
  const result = new IntradayIntelligenceService().evaluate({ price: 100, atr: 1, adx: 28, direction: 1, ema20: 98, volumeRatio: 1.8, volume: 50_000, selectionScore: 80, sufficientHistory: true, dataFresh: true, candleClosed: true, riskReward: 2, latestCandle: { open: 99, high: 101, low: 99, close: 100.9, volume: 50_000 }, previousCandle: { volume: 20_000 }, marketStructure: { higherHigh: true, higherLow: true } });
  assert.equal(result.marketContext.marketRegime, 'UNCERTAIN');
  assert.equal(result.multiTimeframeAlignment.status, 'UNVERIFIED');
  assert.equal(result.historicalEvidence.calibratedProbability, null);
  assert.equal(result.finalDecision, 'NO TRADE');
});

test('rejects incomplete and weak-volume setup candles', () => {
  const result = new IntradayIntelligenceService().evaluate({ price: 100, atr: 1, adx: 28, direction: 1, ema20: 98, volumeRatio: .7, volume: 10_000, selectionScore: 50, sufficientHistory: true, dataFresh: true, candleClosed: false, riskReward: 2, latestCandle: { open: 100, high: 101, low: 99, close: 100.1, volume: 10_000 }, previousCandle: { volume: 20_000 } });
  assert.ok(result.noTradeReasons.includes('SETUP_NOT_CONFIRMED'));
  assert.ok(result.noTradeReasons.includes('WEAK_VOLUME'));
});
