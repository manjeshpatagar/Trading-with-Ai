import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaperTradingService } from './paper-trading.service';

const service = new PaperTradingService({} as never, {} as never);

const signal = (overrides: Record<string, unknown> = {}) => ({
  id: 'signal-1',
  userId: 'user-1',
  instrumentKey: 'NSE_EQ|TEST',
  symbol: 'TEST',
  side: 'BUY',
  entryPrice: 100,
  currentPrice: 101,
  confidence: 96,
  aiScore: 95,
  riskReward: 3.5,
  signalTime: new Date(),
  status: 'RUNNING',
  stopLoss: 98,
  target1: 104,
  target2: 107,
  target3: 110,
  entryTriggeredAt: new Date(),
  target1At: null,
  target2At: null,
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) => ({
  instrumentKey: 'NSE_EQ|TEST',
  symbol: 'TEST',
  signal: 'BUY',
  price: 101,
  confidence: 96,
  riskReward: 3.5,
  ema20: 100,
  ema50: 99,
  vwap: 100.2,
  rsi: 61,
  macd: 1,
  todayLow: 99,
  todayHigh: 102,
  lastUpdated: new Date().toISOString(),
  entryValidation: { fakeBreakout: false },
  indicators: { atr: 2, volumeRatio: 1.4, adx: 32, macd: { histogram: 1.2 }, momentum: 1.1, support: 99, supertrend: 99.5 },
  ...overrides,
});

test('Demo candle exits early when momentum weakens before hard stop', () => {
  const order = { id: 'order-1', side: 'BUY', entryPrice: 100, stopLoss: 96, quantity: 100 };
  const decision = (service as any).demoDecision(order, signal(), row({
    price: 99,
    ema20: 100,
    ema50: 101,
    vwap: 100.5,
    rsi: 39,
    indicators: { atr: 2, volumeRatio: .45, adx: 14, macd: { histogram: -1 }, momentum: -1, supertrend: 101 },
  }), new Date('2026-07-30T07:00:00.000Z'));
  assert.equal(decision.action, 'EXIT');
  assert.equal(decision.reason, 'Volume Drop');
});

test('Target 1 protects breakeven and Target 2 requires strong continuation', () => {
  const order = { id: 'order-1', side: 'BUY', entryPrice: 100, stopLoss: 96, quantity: 100 };
  const target1Decision = (service as any).demoDecision(order, signal({ target1At: new Date() }), row({ price: 105 }), new Date('2026-07-30T07:00:00.000Z'));
  assert.ok(target1Decision.trailingStop >= 100);

  const target2Decision = (service as any).demoDecision(order, signal({ target1At: new Date(), target2At: new Date() }), row({
    price: 107,
    indicators: { atr: 2, volumeRatio: .75, adx: 20, macd: { histogram: .2 }, momentum: .1, supertrend: 103 },
  }), new Date('2026-07-30T07:00:00.000Z'));
  assert.equal(target2Decision.action, 'BOOK PROFIT');
});

test('3:15 PM keeps only very strong Demo trades', () => {
  const order = { id: 'order-1', side: 'BUY', entryPrice: 100, stopLoss: 98, quantity: 100 };
  const decision = (service as any).demoDecision(order, signal(), row({
    price: 102,
    indicators: { atr: 2, volumeRatio: 1, adx: 26, macd: { histogram: 1 }, momentum: 1, supertrend: 100 },
  }), new Date('2026-07-30T09:46:00.000Z'));
  assert.equal(decision.action, 'BOOK PROFIT');
  assert.equal(decision.reason, 'Time Exit (3:15 PM)');
});

test('initial logical stop chooses the smallest safe risk and never crosses price', () => {
  const stop = (service as any).logicalStop('BUY', row({
    price: 101,
    ema20: 99.8,
    vwap: 100.1,
    todayLow: 98,
    indicators: { atr: 2, swingLow: 99.4, volumeRatio: 1.4 },
  }), 101, 97);
  assert.equal(stop, 100.1);
  assert.ok(stop < 101);
});
