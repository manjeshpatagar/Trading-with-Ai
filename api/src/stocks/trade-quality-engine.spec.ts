import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { tradeQuality } from './trade-quality-engine';

const excellent = { side: 'BUY', aiScore: 99, confidence: 98, momentum: 8, trendStrength: 95, volumeRatio: 3, vwapAligned: true, emaAligned: true, ema200Aligned: true, rsi: 60, macdHistogram: .3, atr: 1.2, price: 100, support: 99, resistance: 103, breakoutConfirmed: true, previousCandleStrength: 95, currentCandleStrength: 95, sectorStrength: 95, marketTrendAligned: true, niftyTrendAligned: true, bankNiftyTrendAligned: true, volatility: 1.2, riskReward: 5, targetDistancePercent: 3, stopDistancePercent: 1, volumeIncreasing: true };
test('excellent aligned setups score for immediate execution', () => { const result = tradeQuality(excellent); assert.ok(result.score >= 96); assert.equal(result.rating, 'Excellent'); assert.equal(result.entryReady, true); });
test('weak setups are skipped below 80', () => { const result = tradeQuality({ ...excellent, aiScore: 40, confidence: 40, volumeRatio: .2, vwapAligned: false, emaAligned: false, ema200Aligned: false, breakoutConfirmed: false, marketTrendAligned: false, sectorStrength: 20, volumeIncreasing: false }); assert.ok(result.score < 80); assert.equal(result.action, 'SKIP'); });
