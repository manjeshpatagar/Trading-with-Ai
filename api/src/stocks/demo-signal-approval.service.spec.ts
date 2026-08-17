import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DemoSignalApprovalService } from './demo-signal-approval.service';

const approvedSignal = (overrides: Record<string, unknown> = {}) => {
  const now = new Date();
  const intelligence = { finalDecision: 'BUY', setup: { setupType: 'BREAKOUT', setupConfirmed: true }, historicalEvidence: { status: 'VERIFIED', calibratedProbability: 64, expectancyR: .42, target1HitRate: 64 }, volumeAnalysis: { volumeDirectionConfirmation: true, relativeVolume: 1.8 }, liquidity: { status: 'TRADABLE' }, multiTimeframeAlignment: { status: 'STRONG' }, marketContext: { marketRegime: 'TRENDING_BULLISH', sectorRegime: 'TRENDING_BULLISH' } };
  return { id: 'signal-1', side: 'BUY', status: 'ENTRY_TRIGGERED', currentPrice: 500, stopLoss: 495, target1: 507.5, target2: 510, riskReward: 2, aiScore: 84, finalDecision: 'BUY', intelligenceJson: JSON.stringify(intelligence), signalTime: now, updatedAt: now, ...overrides };
};

test('approves and ranks only statistically verified Single History decisions', () => {
  const service = new DemoSignalApprovalService();
  const result = service.evaluate(approvedSignal(), 55);
  assert.equal(result.approved, true);
  assert.equal(service.rank([approvedSignal(), approvedSignal({ id: 'weak', riskReward: 1 })], 55).length, 1);
});

test('blocks HOLD, NO TRADE, unverified history, and stale prices', () => {
  const service = new DemoSignalApprovalService();
  const intelligence = JSON.parse(approvedSignal().intelligenceJson);
  intelligence.finalDecision = 'NO TRADE'; intelligence.historicalEvidence.status = 'UNVERIFIED'; intelligence.historicalEvidence.calibratedProbability = null;
  const result = service.evaluate(approvedSignal({ finalDecision: 'NO TRADE', intelligenceJson: JSON.stringify(intelligence), updatedAt: new Date(Date.now() - 180_000) }), 55);
  assert.equal(result.approved, false);
  assert.ok(result.reasons.includes('SINGLE_HISTORY_NOT_APPROVED'));
  assert.ok(result.reasons.includes('HISTORICAL_EVIDENCE_UNVERIFIED'));
  assert.ok(result.reasons.includes('MARKET_DATA_STALE'));
});
