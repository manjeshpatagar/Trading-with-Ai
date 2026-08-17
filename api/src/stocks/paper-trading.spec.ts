import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DemoSignalApprovalService } from './demo-signal-approval.service';
import { calculateDemoIntradayPosition, demoExecutionRejection, demoExitReason, PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';

test('position size is capped by both available capital and configured account risk', () => {
  const sizing = calculateDemoIntradayPosition({ capital: 10_000, accountBalance: 10_000, entryPrice: 500, stopLoss: 495, riskPercent: 1, leverage: 1 });
  assert.equal(sizing.riskQuantity, 20);
  assert.equal(sizing.marginQuantity, 20);
  assert.equal(sizing.quantity, 20);
  assert.equal(sizing.maximumRisk, 100);
});

test('same approved signal received 100 times is ranked exactly once', () => {
  const now = new Date();
  const intelligence = { finalDecision: 'BUY', setup: { setupType: 'BREAKOUT', setupConfirmed: true }, historicalEvidence: { status: 'VERIFIED', calibratedProbability: 64, expectancyR: .42, target1HitRate: 64 }, volumeAnalysis: { volumeDirectionConfirmation: true, relativeVolume: 1.8 }, liquidity: { status: 'TRADABLE' }, multiTimeframeAlignment: { status: 'STRONG' }, marketContext: { marketRegime: 'TRENDING_BULLISH', sectorRegime: 'TRENDING_BULLISH' } };
  const signal = { id: 'stable-signal-id', side: 'BUY', currentPrice: 500, stopLoss: 495, target1: 507.5, riskReward: 2, aiScore: 84, finalDecision: 'BUY', intelligenceJson: JSON.stringify(intelligence), signalTime: now, updatedAt: now };
  assert.equal(new DemoSignalApprovalService().rank(Array.from({ length: 100 }, () => ({ ...signal })), 55, now).length, 1);
});

test('frontend/manual legacy endpoint cannot create a paper order', async () => {
  let creates = 0;
  const service = new PaperTradingService({ paperOrder: { create: async () => { creates += 1; } } } as never, new PaperOrderExecutionService());
  assert.equal(await service.createTrade('user-1', { instrumentKey: 'NSE_EQ|TEST' }), false);
  assert.equal(creates, 0);
});

const eligible = (side: 'BUY' | 'SELL', overrides: Record<string, unknown> = {}) => ({ id: `signal-${side}`, userId: 'user-1', instrumentKey: 'NSE_EQ|TEST', symbol: 'TEST', side, entryPrice: 100, currentPrice: 100, stopLoss: side === 'BUY' ? 95 : 105, target1: side === 'BUY' ? 105 : 95, target2: side === 'BUY' ? 110 : 90, target3: side === 'BUY' ? 115 : 85, confidence: 80, aiScore: 80, riskReward: 3, signalTime: new Date('2026-08-17T05:00:00Z'), status: 'ENTRY_TRIGGERED', executionEligible: true, demoExecuted: false, entryTriggeredAt: new Date('2026-08-17T05:01:00Z'), ...overrides });

test('valid BUY and SELL Single History snapshots are execution eligible', () => {
  const at = new Date('2026-08-17T05:02:00Z');
  assert.equal(demoExecutionRejection(eligible('BUY'), at), null);
  assert.equal(demoExecutionRejection(eligible('SELL'), at), null);
});

test('NO_TRADE and duplicate signals cannot execute', () => {
  const at = new Date('2026-08-17T05:02:00Z');
  assert.equal(demoExecutionRejection(eligible('BUY', { status: 'NO_TRADE' }), at), 'SIGNAL_STATUS_NO_TRADE');
  assert.equal(demoExecutionRejection(eligible('BUY', { demoExecuted: true }), at), 'ALREADY_EXECUTED');
});

test('stale signals expire using the configured TTL', () => {
  assert.equal(demoExecutionRejection(eligible('BUY'), new Date('2026-08-17T05:03:01Z'), 120), 'SIGNAL_EXPIRED');
});

test('BUY and SELL target/stop conditions are not reversed', () => {
  assert.equal(demoExitReason('BUY', 115, 115, 95), 'TARGET');
  assert.equal(demoExitReason('BUY', 95, 115, 95), 'STOP_LOSS');
  assert.equal(demoExitReason('SELL', 85, 85, 105), 'TARGET');
  assert.equal(demoExitReason('SELL', 105, 85, 105), 'STOP_LOSS');
  assert.equal(demoExitReason('BUY', 100, 115, 95), null);
});

test('auto trading OFF does not queue or execute a triggered signal', async () => {
  let queueWrites = 0;
  const prisma = { paperTradingAccount: { upsert: async () => ({ autoDemoTrading: false, mode: 'PAUSED' }) }, demoTradeQueue: { upsert: async () => { queueWrites += 1; } } };
  const service = new PaperTradingService(prisma as never, new PaperOrderExecutionService());
  assert.equal(await service.captureTriggeredDemoSignals('user-1', [eligible('BUY')] as never), false);
  assert.equal(queueWrites, 0);
});
