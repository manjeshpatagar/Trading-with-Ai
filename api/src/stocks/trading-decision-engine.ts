export type TradingCandidate = { side: string; strategy?: string | null; confidence: number; aiScore: number; riskReward: number; volumeRatio: number; vwapAligned: boolean; emaAligned: boolean; ema200Aligned: boolean; volumeIncreasing: boolean; marketTrendAligned: boolean; sectorStrength: number; finalTradingScore?: number | null };

export type MarketRegime = 'STRONG_BULLISH' | 'BULLISH' | 'SIDEWAYS' | 'BEARISH';

export function adaptiveMinimumConfidence(regime: MarketRegime) {
  return regime === 'STRONG_BULLISH' ? 75 : regime === 'BULLISH' ? 80 : regime === 'BEARISH' ? 95 : 90;
}

export function marketRegime(c: TradingCandidate): MarketRegime {
  if (!c.marketTrendAligned) return c.side === 'BUY' ? 'BEARISH' : 'SIDEWAYS';
  const strength = Math.max(0, Math.min(100, Number(c.sectorStrength) || 0));
  if (c.side === 'BUY' && strength >= 70 && c.emaAligned && c.vwapAligned) return 'STRONG_BULLISH';
  if (strength >= 50) return 'BULLISH';
  return 'SIDEWAYS';
}

/** V4 institutional execution ranking, normalized to a 0-100 score. */
export function executionScore(c: TradingCandidate, technicalScore = Number(c.aiScore)) {
  const normalize = (value: number) => Math.max(0, Math.min(100, Number(value) || 0));
  const volumeStrength = normalize(Number(c.volumeRatio) / 3 * 100);
  const trendStrength = c.marketTrendAligned ? normalize((c.emaAligned ? 60 : 40) + (c.vwapAligned ? 20 : 0) + (c.ema200Aligned ? 20 : 0)) : 0;
  const riskRewardStrength = normalize(Number(c.riskReward) / 5 * 100);
  return Number((normalize(c.confidence) * .35 + normalize(technicalScore) * .25 + volumeStrength * .15 + trendStrength * .10 + riskRewardStrength * .10 + normalize(c.sectorStrength) * .05).toFixed(4));
}

const PRIORITY: Record<string, number> = { ORB: 6, BREAKOUT: 5, MOMENTUM: 4, 'VWAP PULLBACK': 3, VWAP: 3, 'EMA CONTINUATION': 2, PULLBACK: 2, REVERSAL: 1 };
export const strategyPriority = (strategy?: string | null) => PRIORITY[String(strategy ?? '').trim().toUpperCase()] ?? 0;

export function finalTradingScore(c: TradingCandidate) {
  const saved = Number(c.finalTradingScore);
  if (Number.isFinite(saved) && saved > 0) return Math.max(0, Math.min(100, saved));
  return Math.max(0, Math.min(100, Number(c.confidence) * .30 + Number(c.aiScore) * .20 + Math.min(100, Number(c.volumeRatio) / 3 * 100) * .15 + (c.emaAligned && c.ema200Aligned ? 10 : 0) + (c.vwapAligned ? 10 : 0) + Math.min(100, Number(c.riskReward) / 4 * 100) * .10 + Math.max(0, Math.min(100, Number(c.sectorStrength))) * .05));
}

export function strictEntryDecision(c: TradingCandidate, minimumAiScore = 75) {
  const score = executionScore(c);
  const regime = marketRegime(c);
  const minimumConfidence = adaptiveMinimumConfidence(regime);
  const checks = [
    { key: 'confidence', pass: Number(c.confidence) >= minimumConfidence, reason: `Confidence below adaptive ${minimumConfidence}% (${regime})` },
    { key: 'ai-score', pass: Number(c.aiScore) >= minimumAiScore, reason: `AI score below ${minimumAiScore}%` },
    { key: 'risk-reward', pass: Number(c.riskReward) >= 3, reason: 'Risk/reward below 1:3' },
    { key: 'market-trend', pass: Boolean(c.marketTrendAligned), reason: 'Market trend is not aligned' },
    { key: 'sector', pass: Number(c.sectorStrength) >= 40, reason: 'Sector strength is weak' },
    { key: 'ema', pass: Boolean(c.emaAligned), reason: 'EMA alignment failed' },
    { key: 'vwap', pass: Boolean(c.vwapAligned), reason: 'VWAP confirmation failed' },
    { key: 'volume', pass: Number(c.volumeRatio) >= 1 && Boolean(c.volumeIncreasing), reason: 'Volume must be increasing and at least average' },
    { key: 'score', pass: score >= 75, reason: 'Final trading score below 75' },
  ];
  const failed = checks.find((check) => !check.pass);
  return { ready: !failed, reason: failed?.reason ?? 'Qualified', score, regime, minimumConfidence, checks };
}

export function automaticRiskProfile(tradingCapital: number, recoveryMode = false, winningStreak = false) {
  const capital = Math.max(0, Number(tradingCapital) || 0);
  const riskPercent = recoveryMode ? .5 : winningStreak ? 1.1 : 1;
  return { riskPercent, riskAmount: capital * riskPercent / 100, maxDailyLoss: capital * .03, maxOpenTrades: 5 };
}

export function riskBasedQuantity(input: { capital: number; availableMargin: number; entryPrice: number; stopLoss: number; recoveryMode?: boolean; winningStreak?: boolean }) {
  const profile = automaticRiskProfile(input.capital, input.recoveryMode, input.winningStreak);
  const stopDistance = Math.abs(Number(input.entryPrice) - Number(input.stopLoss));
  if (!(stopDistance > 0) || !(input.entryPrice > 0)) return { quantity: 0, stopDistance, ...profile };
  const quantity = Math.min(Math.floor(profile.riskAmount / stopDistance), Math.floor(Math.max(0, input.availableMargin) / input.entryPrice));
  return { quantity: Math.max(0, quantity), stopDistance, ...profile };
}
