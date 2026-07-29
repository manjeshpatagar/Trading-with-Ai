import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { TradeManagementService } from './trade-management.service';

const row = (overrides: Record<string, unknown> = {}) => ({
  price: 110,
  confidence: 94,
  riskReward: 2.5,
  ema20: 108,
  ema50: 104,
  vwap: 107,
  rsi: 62,
  patterns: [],
  entryValidation: { breakoutConfirmed: true, fakeBreakout: false },
  candleAnalysis: { current: 'Strong Bullish Candle' },
  indicators: { adx: 31, volumeRatio: 1.8, resistance: 120, support: 100, macd: { histogram: 1.2 } },
  ...overrides,
});

test('allows re-entry only when every strict continuation gate passes', () => {
  const service = new TradeManagementService({} as any);
  const evidence = (service as any).evidence(row(), 'BUY');
  assert.equal(evidence.reentryAllowed, true);
  assert.equal(evidence.strongContinuation, true);
});

test('rejects re-entry and requests an AI exit on multi-factor reversal', () => {
  const service = new TradeManagementService({} as any);
  const evidence = (service as any).evidence(row({
    price: 98,
    ema20: 99,
    ema50: 104,
    vwap: 102,
    rsi: 36,
    candleAnalysis: { current: 'Bearish Engulfing' },
    patterns: ['Bearish Engulfing'],
    entryValidation: { breakoutConfirmed: false, fakeBreakout: true },
    indicators: { adx: 14, volumeRatio: .4, resistance: 101, support: 97, macd: { histogram: -1.1 } },
  }), 'BUY');
  assert.equal(evidence.reentryAllowed, false);
  assert.equal(evidence.reversal, true);
});
